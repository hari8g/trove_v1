# Trove v1 — Architecture Analysis, Gap Report & Incremental Phase Plan

> Analysed from `https://github.com/hari8g/trove_v1.git`  
> Compared against Cursor as the reference agentic IDE benchmark

---

## 1. How the Codebase is Wired

### 1.1 Three-Layer Architecture

Trove follows VSCode's strict process-boundary pattern. Every Trove file lives in one of three zones with hard import rules:

| Layer | Directory | Allowed to import |
|---|---|---|
| Electron-Main | `electron-main/` | Node.js APIs · SQLite · fs · crypto · common/ |
| Common | `common/` | Types only · no Node · no DOM |
| Browser | `browser/` | DOM · VS Code browser APIs · common/ |
| React UI | `browser/react/src/` | React · browser services (via accessor bridge) |

### 1.2 Key Services and Their Roles

**`chatThreadService.ts`** — the beating heart. It owns the entire agentic loop state machine:
- Maintains `ThreadsState` (all conversation threads, persisted to VSCode storage)
- Manages `ThreadStreamState` — a discriminated union tracking whether the system is `LLM | tool | awaiting_user | idle | undefined`
- Runs the `while(shouldSendAnotherMessage)` loop that calls the LLM, receives a tool call, dispatches `_runToolCall()`, and loops until no tool is called
- Implements the checkpoint snapshot system: every user message and LLM edit gets a `VoidFileSnapshot` so diffs can be rewound

**`convertToLLMMessageService.ts`** — message preparation. Before every LLM call it:
- Builds the system prompt from `prompts.ts` including workspace tree and RepoIntelligence profile
- Converts Trove's internal `ChatMessage` format to provider-specific shapes (Anthropic / OpenAI / Gemini)
- Handles tool result formatting across all three wire formats

**`toolsService.ts`** — 14 built-in tools. Structured as three typed maps: `validateParams[toolName]`, `callTool[toolName]`, `stringOfResult[toolName]`. This makes adding a new tool a matter of adding one entry to each map.

**`agentDeliveryService.ts`** — post-run delivery intelligence. After terminal tool calls it detects build success / dev server start / localhost URLs and synthesises a `AgentDeliverySummary` card (status: `build_succeeded | server_running | verified`). It auto-opens SimpleBrowser on detected localhost URLs.

**`repoIntelligenceService` (electron-main)** — SQLite-backed workspace profile. On first open it runs `workspaceScanner.ts` to detect languages, frameworks, package managers, and commands. It then calls the LLM to generate `projectPurpose` and `architectureSummary` summaries. Results are cached in a SQLite DB keyed by a SHA-256 hash of the workspace root. Profiles expire after 24 hours or manual refresh.

**`sendLLMMessageService.ts`** (common) — the IPC bridge. It:
- Generates a `requestId` UUID per request
- Stores `onText / onFinalMessage / onError / onAbort` callbacks in a local hook map
- Calls `channel.call('sendLLMMessage', params)` to the main process, stripping callbacks (IPC can't carry functions)
- Registers `channel.listen('onText_sendLLMMessage', ...)` events to route responses back to the right callbacks via `requestId`

**`LLMMessageChannel.ts`** (electron-main) — the other side of the IPC. It holds `Emitter` instances for each event type and fires them with `requestId` so all browser-side listeners can filter to their own request.

### 1.3 The Agentic Loop — Step by Step

```
1. User submits → chatThreadService.sendNewMessage()
2. Thread state updated, _wrapRunAgentToNotify() begins
3. _runChatAgent() enters while(shouldSendAnotherMessage) loop
4.   convertToLLMMessageService.prepareLLMChatMessages()
       → Build system message (prompts.ts + workspace tree + repo profile)
       → Convert ChatMessage[] → provider wire format
5.   llmMessageService.sendLLMMessage() via IPC
       → LLMMessageChannel.call('sendLLMMessage', params) in main process
       → sendLLMMessage.impl.ts makes HTTP call to provider
       → onText events stream back through channel.listen()
6.   onFinalMessage resolves the loop promise
7.   If toolCall present:
       a. _runToolCall(toolName, id, rawParams)
       b. validateParams[toolName](rawParams) → typed params
       c. Check approvalType (edits | terminal | MCP tools)
       d. If approval needed → set isRunning:'awaiting_user', break
       e. callTool[toolName](params) → result
       f. For terminal tools → agentDeliveryService.handleTerminalToolResult()
       g. Add tool result message to thread
       h. shouldSendAnotherMessage = true → loop
8.   If no tool call → finalizeDelivery() + addUserCheckpoint() → loop ends
```

### 1.4 IPC Channel Registry

| Channel name | Direction | Methods |
|---|---|---|
| `trove-channel-llmMessage` | browser → main → browser | call: sendLLMMessage, abort, ollamaList, openAICompatibleList · listen: onText, onFinalMessage, onError, onSuccess/Error_list_* |
| `trove-channel-repoIntelligence` | browser → main | call: getProfile, refreshProfile |
| `trove-channel-scm` | browser → main | SCM operations (commit, branch, etc.) |
| `trove-channel-metrics` | browser → main | capture events |
| `trove-channel-mcp` | browser → main | tool discovery, tool invocation |
| `trove-channel-update` | browser → main | check/install updates |

---

## 2. Gap Analysis vs Cursor

### 2.1 What Cursor Does That Trove Does Not Yet

| Gap | Impact | Trove state |
|---|---|---|
| **Semantic / vector code search** | Agent can't find relevant code without exact filenames | Only text search exists; SQLite stores file metadata only (path/lang/size) — no embeddings |
| **@ mentions (file, symbol, docs, web)** | Users must describe context verbally, agent has to search for it | `stagingSelections` type exists in ChatMessage but no @ picker in UI; only drag-to-stage is possible |
| **Project rules file (`.cursorrules`)** | Per-project AI behaviour can't be customised | No `.troverules` file is read or injected into the system prompt |
| **ContextGatheringService** | Nearby code context not auto-included in autocomplete | Service is fully implemented but **commented out** in `trove.contribution.ts` — zero snippets are gathered |
| **Codebase-aware autocomplete** | FIM completions don't consider imports or related files | `autocompleteService` uses prefix/suffix only; no cross-file context |
| **Structured plan view** | User can't see what the agent plans to do before it acts | No plan message type; agent outputs freeform markdown, then immediately starts tool use |
| **Parallel tool execution** | Multiple independent reads (3× read_file) execute serially | `_runToolCall` is awaited one at a time; no batching of non-destructive tools |
| **Smart context window management** | Long conversations hit token limits without graceful trimming | `prepareLLMChatMessages` builds the full history every time; no trimming heuristic |
| **Multi-file diff review panel** | After bulk edits, no summary view to accept/reject all | Checkpoints exist but there's no aggregate "n files changed, accept all" UI |
| **Web search tool** | Agent can't look up docs, APIs, or recent information | No `@web` or `search_web` builtin; only local tools |
| **Memory / persistent instructions** | Agent forgets project conventions across sessions | No per-user or per-project memory beyond the chat history |
| **Shadow workspace (safe apply)** | Edits go directly to real files | `editCodeService` edits the live model; undo is via checkpoint diff revert |

### 2.2 What Trove Already Does Well

- **Clean 3-layer architecture** with no illegal cross-process imports — this is the hardest structural constraint to retrofit later.
- **Full multi-provider support** (Anthropic, OpenAI, Ollama, vLLM, LiteLLM, DeepSeek, OpenRouter, Gemini) with a single sendLLMMessage API.
- **Real terminal integration** with shell integration parsing (`]633;D` exit codes), persistent terminals, dev server detection, and auto-open preview.
- **MCP integration** — MCP tools are discovered and passed to the LLM alongside builtins.
- **Checkpoint snapshot system** — every file edit is snapshot-diffable. This is a solid base for the shadow workspace.
- **AgentDeliverySummary** — the build/run/preview delivery card is a differentiator over Cursor's simpler output.
- **Repo Intelligence** — LLM-generated purpose + architecture summaries are already injected into the system prompt.

---

## 3. Incremental Phase Plan

Constraint: every phase must be additive, not rewire existing services, and be independently shippable.

---

### Phase 1 — Activate ContextGatheringService + @ File Picker
**Effort: ~3 days**  
**Files touched: 3**

The ContextGatheringService is complete and ready — it just isn't registered.

**Step 1a** — Uncomment the import in `trove.contribution.ts`:
```ts
import './contextGatheringService.js'  // remove the comment
```

**Step 1b** — In `convertToLLMMessageService.ts`, inject gathered snippets into the user message prefix:
```ts
// existing: const userContent = chat_userMessageContent(...)
// add:
const snippets = contextGatheringService.getCachedSnippets()
const snippetBlock = snippets.length
  ? `\n\n<recently_viewed_code>\n${snippets.slice(0, 4).join('\n---\n')}\n</recently_viewed_code>`
  : ''
// prepend to the first user message in the thread
```

**Step 1c** — Add `@` trigger to `SidebarChat.tsx` textarea. When user types `@`, show a file picker dropdown using VSCode's existing `IWorkspaceContextService` and `IFileService`. On selection, add to `stagingSelections` (already typed in `ChatMessage`).

**Why now:** Zero risk. The service is already tested logic. The `stagingSelections` type already exists and is already rendered in the UI. This is the highest-ROI change in the backlog.

---

### Phase 2 — Project Rules File (`.troverules`)
**Effort: ~1 day**  
**Files touched: 3**

**Step 2a** — In `repoIntelligenceService.ts` (browser side), on workspace open, call `fileService.readFile` on `{workspaceRoot}/.troverules`. Cache the result in local state.

**Step 2b** — Expose via `IRepoIntelligenceService`:
```ts
getWorkspaceRules(): string | null
```

**Step 2c** — In `convertToLLMMessageService.ts`, inject the rules content into `chat_systemMessage()` call in `prompts.ts` as a new `workspaceRules` parameter. Add a section to the system prompt:
```
<workspace_rules>
{contents of .troverules}
</workspace_rules>
```

No new IPC channel needed — file reading can happen in the browser process using the existing `IFileService` which already works across the renderer.

---

### Phase 3 — Semantic Code Chunking + `search_codebase` Tool
**Effort: ~1.5 weeks**  
**Files touched: 5**

This extends the existing `repoIntelligenceDb.ts` and `workspaceScanner.ts` without changing any IPC contracts.

**Step 3a** — Add two tables to the existing SQLite schema in `repoIntelligenceDb.ts`:
```sql
CREATE TABLE IF NOT EXISTS code_chunks (
  id             TEXT PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  chunk_text     TEXT NOT NULL,
  start_line     INTEGER,
  end_line       INTEGER,
  chunk_type     TEXT,   -- 'function' | 'class' | 'block' | 'file'
  tfidf_tokens   TEXT,   -- JSON array of {token, weight}
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_text, file_path, workspace_hash UNINDEXED
);
```

**Step 3b** — In `workspaceScanner.ts`, after file collection, split each file into chunks at function/class boundaries using regex heuristics (simple: split on `\nfunction `, `\nclass `, `\nexport default`). Write chunks to the new table.

**Step 3c** — Add `search_codebase` to `builtinTools` in `prompts.ts`:
```ts
search_codebase: {
  description: 'Semantically search the codebase for code related to a query. Returns ranked file paths and line ranges.',
  params: {
    query: { type: 'string', description: 'Natural language description of what to find' },
    max_results: { type: 'string', description: 'Max results to return (default 10)' }
  }
}
```

**Step 3d** — Add handler in `toolsService.ts` → calls via IPC `repoIntelligenceChannel` → FTS5 query on `chunks_fts` table → returns ranked `{filePath, startLine, endLine, snippet}[]`.

This avoids any external embedding dependency — FTS5 is already available in `@vscode/sqlite3` and gives surprisingly strong recall for code search.

---

### Phase 4 — Codebase-Aware Autocomplete Context
**Effort: ~3 days**  
**Files touched: 2**

Augment `autocompleteService.ts` to prepend relevant snippets from Phase 3's index to the FIM prefix.

**Step 4a** — When building the FIM request, extract the current file's import statements and the symbol under the cursor.

**Step 4b** — Call `repoIntelligenceService.searchChunks(query)` with those symbols as the query. Take the top 2-3 results.

**Step 4c** — Prepend them to the FIM prefix as a comment block:
```ts
// Related code from codebase:
// [snippet from fileA.ts lines 12-28]
// [snippet from fileB.ts lines 44-61]
```

No prompt format changes in `prompts.ts` needed — only the autocomplete service's FIM message builder.

---

### Phase 5 — Parallel Read Tool Batching
**Effort: ~2 days**  
**Files touched: 2**

When the LLM returns a tool call, instead of immediately executing it and looping, accumulate consecutive read-only tool calls in one pass.

This requires a **two-pass approach** inside `_runChatAgent`:

**Step 5a** — After `onFinalMessage`, before dispatching the single tool call, check if the tool is in the read-only set: `{'read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'search_codebase'}`.

**Step 5b** — If so, call the LLM once more with `max_tokens=200` and a system prompt addendum: "List ALL additional read-only tool calls you need to make at this step, one per line. Reply with DONE if none." Parse the response to extract up to 4 additional calls.

**Step 5c** — Execute the full batch with `Promise.all()` and add all results to the thread before the next LLM call.

This is purely additive inside `chatThreadService.ts` — the existing `_runToolCall` function is used unchanged for each call; only the orchestration loop changes.

---

### Phase 6 — Smart Context Window Trimming
**Effort: ~2 days**  
**Files touched: 2**

Add token budget management to `convertToLLMMessageService.ts`.

**Step 6a** — Add a `estimateTokens(text: string): number` helper (`text.length / 4` is a reliable fast estimate).

**Step 6b** — Look up `maxContextTokens` from `modelCapabilities.ts` for the active model (already imported in the service).

**Step 6c** — In `prepareLLMChatMessages`, after building the message array, sum token estimates. If over `maxContextTokens * 0.85`, trim the middle of the history: remove the oldest non-checkpoint, non-user messages first. Preserve the system message, the last 2 user turns, and all checkpoint messages.

**Step 6d** — Add a visible indicator in `SidebarChat.tsx` when trimming occurs: "Older context was trimmed to fit the model's window."

---

### Phase 7 — Structured Plan Message Type
**Effort: ~4 days**  
**Files touched: 5**

Add a `plan` message type that the agent generates before starting its tool-use loop.

**Step 7a** — Add to `ChatMessage` union in `chatThreadServiceTypes.ts`:
```ts
{ role: 'plan'; items: { text: string; status: 'pending' | 'done' | 'skipped' }[]; threadId: string }
```

**Step 7b** — In `_runChatAgent`, before the main `while` loop, make a single lightweight LLM call with a system prompt like: *"In 3-7 bullet points, list the concrete steps you will take to complete this task. Use infinitive form. Output only the list, no prose."* Parse response as bullet items into a `plan` message.

**Step 7c** — Add a `PlanView.tsx` React component that renders the plan message as a checklist. Update step status to `done` when the matching tool call completes.

**Step 7d** — The plan call uses `max_tokens: 300` and is a separate `sendLLMMessage` call — it doesn't affect the main loop budget or message history.

---

### Phase 8 — Multi-File Diff Review Panel
**Effort: ~5 days**  
**Files touched: 4**

After the agent loop completes, aggregate all pending diffs across files.

**Step 8a** — In `chatThreadService.ts`, after `finalizeDelivery()`, collect all `DiffArea` objects that are in `pending` state across all open editors using `editCodeService.getPendingDiffs()`.

**Step 8b** — Emit a new `onDidFinishAgentRun` event with `{ threadId, pendingDiffCount, filesChanged: URI[] }`.

**Step 8c** — In `AgentDeliverySummary.tsx`, when `pendingDiffCount > 1`, show an "Accept all N changes" / "Reject all" button row in the delivery card. These call `editCodeService.acceptAll()` / `editCodeService.rejectAll()`.

This builds on the existing `editCodeService` accept/reject APIs — just adding a bulk wrapper.

---

### Phase 9 — Memory / Persistent Instruction File
**Effort: ~2 days**  
**Files touched: 3**

A lightweight `~/.trove/memory.md` that accumulates user-written and agent-learned instructions.

**Step 9a** — Read `TROVE_MEMORY_FILE` (`path.join(environmentService.userDataPath, 'trove-memory.md')`) in `RepoIntelligenceMainService` on startup.

**Step 9b** — Expose via `IRepoIntelligenceService.getUserMemory(): string | null`.

**Step 9c** — Inject into system prompt in `prompts.ts` under a `<user_memory>` block, after `<workspace_rules>` (Phase 2).

**Step 9d** — Add a "Remember this" command to the command bar that appends to the file via `fileService.writeFile`.

---

## 4. Phase Priority Matrix

| Phase | ROI | Risk | Effort | Recommended order |
|---|---|---|---|---|
| 1 — ContextGathering + @ picker | 🔥 Very high | Very low | 3 days | **First** |
| 2 — .troverules file | High | Very low | 1 day | **Second** |
| 6 — Context window trimming | High | Low | 2 days | **Third** |
| 7 — Structured plan view | High | Low | 4 days | **Fourth** |
| 3 — Semantic search (FTS5) | Very high | Medium | 1.5 weeks | **Fifth** |
| 5 — Parallel tool batching | Medium | Low | 2 days | **Sixth** |
| 4 — Codebase autocomplete | High | Low | 3 days | After Phase 3 |
| 8 — Multi-file diff panel | Medium | Low | 5 days | After Phase 7 |
| 9 — Memory file | Medium | Very low | 2 days | Any time after Phase 2 |

---

## 5. Golden Rules for All Phases

1. **Never cross the browser/electron-main boundary outside of existing channels.** Add IPC methods to existing channels rather than creating new ones.
2. **All new builtin tools go in `builtinTools` in `prompts.ts` first** — the `validateParams / callTool / stringOfResult` maps in `toolsService.ts` follow the type.
3. **New message types go in `chatThreadServiceTypes.ts`.** The React layer reads from `thread.messages` — new types need a renderer case in `SidebarChat.tsx`.
4. **Don't modify `_runChatAgent` control flow** for Phases 1-6. Inject at the edges (before the loop in `prepareLLMChatMessages`, or after `finalizeDelivery`).
5. **Feature flags via `ITroveSettingsService`.** Any new capability should have a corresponding `FeatureName` so users can opt out.
