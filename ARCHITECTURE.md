# Trove Architecture

This document describes how Trove is structured on top of VS Code OSS: process boundaries, the agent loop, token economy, IPC, core services, and conventions for extending the system.

---

## 1. High-level overview

Trove is not a VS Code extension. It is a **workbench contribution** compiled into the editor binary, with privileged access to the file system, terminal, and main process (for LLM HTTP calls and SQLite).

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Electron Application                            │
├──────────────────────────────┬──────────────────────────────────────────┤
│     Browser (Renderer)       │         Electron Main                    │
│  VS Code Workbench + DOM     │  Node.js · fs · crypto · HTTP · SQLite   │
│                              │                                          │
│  ┌────────────────────────┐  │  ┌────────────────────────────────────┐  │
│  │  trove/browser/        │  │  │  trove/electron-main/              │  │
│  │  · chatThreadService   │◄─┼──┤  · sendLLMMessageChannel           │  │
│  │  · toolsService        │  │  │  · sendLLMMessage.impl (HTTP)      │  │
│  │  · convertToLLM...     │  │  │  · repoIntelligence (SQLite)       │  │
│  │  · webSearchService    │  │  │  · mcpChannel · troveSCM · metrics   │  │
│  │  · React UI (sidebar)  │  │  └────────────────────────────────────┘  │
│  └──────────┬─────────────┘  │                                          │
│             │ imports         │                                          │
│  ┌──────────▼─────────────┐  │                                          │
│  │  trove/common/         │  │                                          │
│  │  types · prompts · IPC │  │                                          │
│  │  interfaces (no I/O)   │  │                                          │
│  └────────────────────────┘  │                                          │
└──────────────────────────────┴──────────────────────────────────────────┘
```

**Golden rule:** Browser code must not import Node APIs or touch the network for LLM calls directly. Main process must not touch the DOM. Shared logic belongs in `common/` as types and pure helpers.

Channel registration happens in `src/vs/code/electron-main/app.ts` (search for `trove-channel-`).

---

## 2. Directory map

All Trove code lives under `src/vs/workbench/contrib/trove/`.

| Path | Role |
|------|------|
| `common/` | Types, prompts, settings schemas, IPC service interfaces. No Node, no DOM. |
| `browser/` | Workbench services, tool execution, chat state machine, React mount points. |
| `browser/react/` | React UI (sidebar chat, settings, onboarding, diff widgets). Built with `tsup` → `out/`. |
| `electron-main/` | LLM HTTP, SQLite repo intelligence, MCP main side, SCM, metrics, updates. |
| `browser/trove.contribution.ts` | Entry point: registers all Trove services on workbench startup. |
| `browser/media/trove.css` | Global Trove styles (watermark, editor chrome). |

### Key browser services

| Service | File | Responsibility |
|---------|------|----------------|
| Chat / agent loop | `chatThreadService.ts` | Thread state, `while` agent loop, tool dispatch, checkpoints, idle status, token totals |
| LLM message prep | `convertToLLMMessageService.ts` | Stable/volatile system prompt split, history, provider wire format, context trim, compaction |
| Tools | `toolsService.ts` | Validate, execute, stringify results for builtin tools (read/search/edit/terminal + symbol tools) |
| Web search | `webSearchService.ts` | Tavily HTTP search for `search_web` tool |
| Terminal tools | `terminalToolService.ts` | Shell integration, persistent terminals, exit codes |
| Agent delivery | `agentDeliveryService.ts` | Post-run build/server/localhost detection |
| Edit / diffs | `editCodeService.ts` | Inline diff areas, accept/reject, snapshots |
| Autocomplete | `autocompleteService.ts` | FIM requests; optional codebase context |
| Repo intel (proxy) | `repoIntelligenceService.ts` | Browser facade; `.troverules` loading |
| Context gathering | `contextGatheringService.ts` | Recently viewed code snippets |
| Plan generation | `agentPlan.ts` | Pre-run bullet plan + status updates |
| Parallel reads | `parallelReadToolBatch.ts` | Batch read-only tool calls |
| Context trim | `contextWindowTrim.ts` | Token budget trimming for long threads |
| Tool compaction | `toolResultCompaction.ts` | Replace stale read/search tool bodies with short refs |
| Wire trim | `wireMessageTrim.ts` | Char-budget elision of oldest tool results on wire |
| File read dedup | `fileReadDedup.ts` | Range-aware skip for duplicate `read_file` calls within a run |
| Agent hints | `agentReadHints.ts`, `agentEditHints.ts`, `agentVerificationHints.ts`, `agentEditCompletionHints.ts` | Inject `<agent_hints>` tail messages when the agent repeats reads/edits or skips verification |
| Anthropic wire | `anthropicConversationWire.ts` | Preflight conversation role order; safe hint injection without prefill violation |
| Agent loop limits | `agentLoopLimits.ts`, `agentLoopSettings.ts` | Max iterations, read-only cap, consecutive fail cap, stream stall timeout |
| Edit diagnostics | `agentEditDiagnostics.ts` | Structured `[Trove edit]` pipeline logging |
| Rate limits | `llmRateLimit.ts` | Input token caps, retry-after parsing, backoff |
| Memory intent | `chatMemoryIntent.ts` | Parse “remember that …” chat messages |
| RIAF | `riafAgentRunController.ts`, `riafAgentService.ts`, `analyseRepositoryAction.ts` | Deep repo analysis → `{repo}_context.md` |
| Workspace preview | `workspacePreviewService.ts`, `openWorkspacePreviewAction.ts`, `simpleBrowserOpen.ts` | Open/reload localhost preview in Simple Browser |

### Key common modules (token economy)

| Module | File | Responsibility |
|--------|------|----------------|
| Prompt cache helpers | `promptCache.ts` | `cache_control` blocks for routed Anthropic models; stable/volatile system split on OpenAI wire |
| Agent output limits | `agentOutputTokenLimits.ts` | Agent-mode max output tokens; Anthropic beta headers (extended output) |
| Token usage | `llmMessageUsage.ts` | Normalize provider usage; per-run totals and summary log |
| Directory tree cache | `directoryStrService.ts` | Workspace tree string with invalidation on edits |

### Key main-process modules

| Module | File | Responsibility |
|--------|------|----------------|
| LLM IPC | `sendLLMMessageChannel.ts` | Routes streaming events by `requestId` |
| LLM HTTP | `llmMessage/sendLLMMessage.impl.ts` | Provider-specific API calls, prompt caching headers |
| Preview probe | `previewProbeChannel.ts` | Main-process HTTP probe for localhost readiness (bypasses renderer CSP) |
| Repo intelligence | `repoIntelligence/repoIntelligenceService.impl.ts` | Profile generation, chunk index, symbol index, search |
| SQLite schema | `repoIntelligence/repoIntelligenceDb.ts` | Workspace profiles, FTS5 `code_chunks`, `symbols` + `symbols_fts`; legacy KG migration |
| Workspace scan | `repoIntelligence/workspaceScanner.ts` | Detect stack, collect files |
| Code chunker | `repoIntelligence/codeChunker.ts` | Split files for search index; extract named symbols (functions, classes, etc.) |

---

## 3. Layer rules and imports

| Layer | May import | Must not import |
|-------|------------|-----------------|
| `electron-main/` | Node, `common/` | `browser/`, DOM APIs |
| `browser/` | VS Code browser APIs, `common/` | Node-only modules |
| `common/` | Other `common/`, base utilities | Node, DOM |
| `browser/react/src/` | React, browser services via accessor bridge | Direct main-process APIs |

React components reach VS Code services through `browser/react/src/util/services.tsx` (instantiation service bridge).

**React build notes** (`browser/react/README.md`):

- External imports must use a `.js` extension.
- Keep `src/` one folder deep so `tsup` externals detection works.
- Dev app loads bundles from `out/vs/workbench/contrib/trove/browser/react/out/` — `build.js` syncs after each build.

---

## 4. The agentic loop

`chatThreadService.ts` owns the state machine. High-level flow:

```mermaid
sequenceDiagram
    participant User
    participant Chat as chatThreadService
    participant Convert as convertToLLMMessageService
    participant IPC as sendLLMMessageService
    participant Main as LLMMessageChannel
    participant Tools as toolsService

    User->>Chat: sendNewMessage()
    Chat->>Chat: remember intent? (skip LLM if memory-only)
    Chat->>Chat: generateAgentPlan() (optional)
    Chat->>Convert: buildRunContext() once per run (stable + volatile blocks)
    loop while shouldSendAnotherMessage
        Chat->>Convert: prepareLLMChatMessages(precomputedRunContext)
        Convert->>Convert: compact stale tools + trim history + wire elision
        Chat->>IPC: sendLLMMessage(separateSystemMessage, volatileSystemMessage, threadId)
        IPC->>Main: IPC call (enablePromptCache)
        Main-->>IPC: onText / onFinalMessage + usage
        alt tool call returned
            Chat->>Chat: parallelReadToolBatch? (read-only)
            Chat->>Tools: validateParams → callTool
            Tools-->>Chat: tool result message (compactable flag)
            Chat->>Chat: invalidate directory cache if needed
            Chat->>Chat: update plan item status
        else no tool call
            Chat->>Chat: finalizeDelivery(), checkpoint, log token summary
        end
    end
```

### Stream state

`ThreadStreamState` is a discriminated union: `LLM | tool | awaiting_user | idle | undefined`. User approval for edits, terminal, or MCP tools sets `awaiting_user` until approved or rejected.

While `idle`, the UI shows **`idleStatus`** (`{ title, detail? }`) — e.g. “Building workspace context”, “Waiting for claude-…”, “Planning parallel reads”.

### Chat modes (`common/troveSettingsTypes.ts`)

| Mode | Tools |
|------|-------|
| `agent` | All builtins + MCP |
| `gather` | Read/search only (no edit, delete, terminal) |
| `normal` | No tools |

---

## 5. Message model

Defined in `common/chatThreadServiceTypes.ts`. The UI (`SidebarChat.tsx`) renders each `role`.

| Role | Purpose |
|------|---------|
| `user` | User text + `stagingSelections` (staged files/context) |
| `assistant` | Model text + optional reasoning |
| `tool` | Tool request / running / success / error / rejected; success may set `compactable: true` |
| `checkpoint` | File snapshots for rewind (`user_edit` \| `tool_edit`) |
| `plan` | Checklist items (`pending` \| `done` \| `skipped`) |
| `interrupted_streaming_tool` | Decorative cancel marker |

**Warning in source:** changing `ChatMessage` shape requires migration — persisted in VS Code storage.

---

## 6. LLM pipeline

### 6.1 Message preparation (`convertToLLMMessageService.ts`)

Before each LLM call:

1. **`buildRunContext`** (once per agent run) — builds `{ stableBlock, volatileBlock }`:
   - **Stable** (`chat_systemMessage_stable`): OS info, workspace folders, mode rules, tool definitions, repo profile, `.troverules`, user memory, file-reading policy. Cached across turns.
   - **Volatile** (`chat_systemMessage_volatile`): active file, open files, persistent terminal IDs, directory tree. Rebuilt when workspace state changes but does not invalidate the cache prefix.
2. **`prepareLLMChatMessages`** (each loop turn) — reuses `precomputedRunContext` when provided; combines both blocks for context-window trimming but passes them separately to the LLM layer.
3. **`trimChatMessagesForContextWindow`** — structural history trim when over budget.
4. **`compactStaleToolResults`** — replaces old read/search tool bodies outside the protected tail with one-line references.
5. Convert internal `ChatMessage[]` to provider format (Anthropic / OpenAI / Gemini).
6. **Wire trim** (`wireMessageTrim.ts`) — `elideOldestToolResultsFirst` drops oldest tool bodies to fit char budget; uses `computeEffectiveOutputReserve` instead of reserving half the context window for output.

Returns `separateSystemMessage` (stable only) and `volatileSystemMessage` for the main-process HTTP layer.

### 6.2 Prompt caching (`common/promptCache.ts`, `sendLLMMessage.impl.ts`)

When `enablePromptCache` is on (Trove Settings → Agent & token economy):

- **Native Anthropic** — three cache breakpoints with `cache_control: { type: 'ephemeral', ttl: '1h' }`:
  1. **Stable system block** — tools, rules, repo profile (not invalidated by file switches).
  2. **Tools array** — last tool definition block.
  3. **Conversation prefix** — last content block of the second-to-last user message (`addConversationCacheBreakpoint`).
  - Volatile system content (open files, directory tree) is sent as a **separate uncached** system block.
  - Extended output uses `anthropic-beta: output-128k-2025-02-19` for agent mode only (prompt caching is GA; no caching beta header).
- **Routed Claude** (OpenRouter, Bedrock, LiteLLM, Azure) — stable system block cached via `applyRoutedAnthropicPromptCache`; volatile block appended uncached.
- **OpenAI** — `prompt_cache_key: trove:${threadId}:${modelName}` routes identical-prefix requests to the same backend shard for improved automatic prefix caching.

### 6.3 File read dedup (`fileReadDedup.ts`)

Within a single agent run, `shouldSkipDuplicateFileRead` skips `read_file` only when the requested line range is **fully covered** by a prior read of the same file — not on any second read regardless of range. This prevents redundant full-file reads while still allowing targeted range reads of unseen sections.

### 6.4 Token usage (`common/llmMessageUsage.ts`)

Each `onFinalMessage` may include normalized `LLMMessageUsage` (input, output, cache read/write). `chatThreadService` accumulates per-run totals and logs `[Trove agent token usage] …` when the run completes. Healthy multi-turn sessions should show 60–80% of input tokens served from cache after turn 2 when prompt caching is enabled.

### 6.5 IPC bridge (`common/sendLLMMessageService.ts`)

- Generates `requestId` per request.
- Passes `enablePromptCache` from global settings.
- Forwards `volatileSystemMessage` and `threadId` (OpenAI cache routing) on chat requests.
- Stores callbacks in a local map (callbacks cannot cross IPC).
- `channel.call('sendLLMMessage', params)` → main process.
- Listens on `onText_sendLLMMessage`, `onFinalMessage_sendLLMMessage`, etc., filtered by `requestId`.

### 6.6 Main process (`sendLLMMessageChannel.ts` + `sendLLMMessage.impl.ts`)

- Emits streaming events with `requestId`.
- Performs HTTP to configured provider using keys from `ITroveSettingsService`.
- Returns usage metadata from provider responses.

### 6.7 Providers (`common/troveSettingsTypes.ts`, `common/modelCapabilities.ts`)

Supported providers include Anthropic, OpenAI, Gemini, Ollama, vLLM, LM Studio, LiteLLM, DeepSeek, OpenRouter, Groq, Mistral, xAI, Google Vertex, and OpenAI-compatible endpoints. Each feature (Chat, Autocomplete, Apply, SCM) can use a different model.

---

## 7. Builtin tools

Tools are declared in `common/prompt/prompts.ts` (`builtinTools`) and implemented in `browser/toolsService.ts` as three parallel maps:

- `validateParams[toolName]` — parse and type raw LLM params
- `callTool[toolName]` — execute
- `stringOfResult[toolName]` — format for LLM consumption

### Tool categories

**Read / search**

| Tool | Description |
|------|-------------|
| `read_file` | File contents (optional line range); range-aware dedup within a run |
| `get_file_outline` | Structural outline of a file (symbols + line ranges, ~50 tokens) |
| `get_symbol` | Source of one named symbol by line range (~100–300 tokens) |
| `search_symbols` | FTS search for symbols across the workspace by name |
| `ls_dir` | List directory |
| `get_dir_tree` | Tree view of folder |
| `search_pathnames_only` | Filename search |
| `search_for_files` | Content search (substring/regex) |
| `search_codebase` | FTS5-ranked semantic search (repo intelligence DB) |
| `search_in_file` | Line numbers matching query in one file |
| `search_web` | Live web search via Tavily (`webSearchService.ts`) |
| `read_lint_errors` | Linter diagnostics for a file |

Agent mode includes a **file-reading policy** in the stable system prompt: for files >100 lines, prefer `get_file_outline` → `get_symbol` → ranged `read_file` before reading the whole file.

**Edit**

| Tool | Description |
|------|-------------|
| `create_file_or_folder` | Create path |
| `delete_file_or_folder` | Delete (optional recursive) |
| `edit_file` | SEARCH/REPLACE blocks |
| `rewrite_file` | Replace entire file |

**Terminal**

| Tool | Description |
|------|-------------|
| `run_command` | One-shot shell command |
| `run_persistent_command` | Command in persistent terminal (dev servers) |
| `open_persistent_terminal` | New persistent terminal |
| `kill_persistent_terminal` | Close persistent terminal |

MCP tools are merged at prompt time when `chatMode === 'agent'`.

### Approval types

Destructive or sensitive tools require user approval (`toolsServiceTypes.ts`): edits, terminal commands, MCP invocations. Gather mode excludes these from the tool list entirely.

---

## 7a. Agent guardrails and hints

When the agent shows unproductive patterns, Trove appends synthetic user messages containing `<agent_hints>…</agent_hints>` before the next LLM call. Hints are aggregated by `buildAgentTailHints()` in `agentReadHints.ts` and injected via `appendAgentTailHintsToMessages()` in `anthropicConversationWire.ts` so the wire format always ends on a user role (Anthropic requirement).

| Hint module | Trigger |
|-------------|---------|
| `agentEditHints.ts` | Same file edited ≥2×; large file (≥3000 chars) targeted with `rewrite_file` |
| `agentReadHints.ts` | Duplicate read-only tool signature; exploration budget exhausted |
| `fileReadDedup.ts` | Same file read ≥2× (hint path, separate from skip logic) |
| `agentVerificationHints.ts` | Edits applied but no sandbox verification command run |
| `agentEditCompletionHints.ts` | Edit intent detected but no edits applied (truncation/interrupt) |

Loop caps (`agentLoopLimits.ts`, settings in `troveSettingsTypes.ts`) stop runaway agents: max iterations (25), read-only calls (12; 6 in light agent), consecutive tool fails (3), LLM stream stall (60s; 300s during edit streaming).

`agentEditDiagnostics.ts` logs edit pipeline stages (`stream_received`, `apply_start`, etc.) for debugging stuck edits.

### Parallel read batching (`parallelReadToolBatch.ts`)

For read-only tools (including `search_web`, `get_file_outline`, `get_symbol`, `search_symbols`), the agent may issue a lightweight discovery LLM call to collect up to 4 additional read calls, then execute the batch with `Promise.all` before the next main LLM turn.

### Tool result compaction (`toolResultCompaction.ts`)

Successful tool messages for read/search tools are marked `compactable: true`. On later turns, bodies outside the protected tail are replaced with lines like `read_file(path) → <42 lines, lines 1-42>; re-read if needed` before wire conversion.

### Directory tree cache (`directoryStrService.ts`)

The workspace tree string is cached for the run. `invalidateCache()` is called after edits, creates/deletes, and terminal commands that may change the tree.

---

## 8. Repo intelligence

Workspace understanding is **main-process SQLite**, exposed via `trove-channel-repoIntelligence`.

### Lifecycle

1. On workspace open, `workspaceScanner.ts` collects files, detects languages/frameworks/package managers/commands.
2. `codeChunker.ts` splits files into ~80-line chunks for FTS5 `search_codebase`.
3. **`extractSymbolsFromFile`** (same chunker) extracts named symbols (functions, classes, interfaces, types, enums) with signatures, docstrings, and line ranges into the `symbols` table + `symbols_fts` index.
4. **Incremental re-indexing** — per-file SHA-256 content hashes in `file_metadata.content_hash`; only changed files are re-chunked/re-symbolized on refresh.
5. **`_migrateLegacyKnowledgeGraph`** — on startup, drops pre-v2 schemas (`symbol_id` PK, `symbol_edges`, `symbol_embeddings`, FTS without `workspace_hash`) before creating v2 `symbols` + `symbols_fts`.
6. LLM generates `projectPurpose` and `architectureSummary` (cached).
7. Profile keyed by SHA-256 hash of workspace root; expires after 24h or manual refresh.

### SQLite schema (`repoIntelligenceDb.ts`)

| Table | Purpose |
|-------|---------|
| `workspace_profiles` | Stack, frameworks, commands, LLM summaries |
| `file_metadata` | Per-file language, mtime, size, `content_hash` |
| `code_chunks` + `chunks_fts` | BM25 semantic search (`search_codebase`) |
| `symbols` + `symbols_fts` | Named symbol index (`get_file_outline`, `get_symbol`, `search_symbols`) |

DB path: `<userData>/User/globalStorage/trove-repo-intelligence.db`

### Browser-side additions

- `repoIntelligenceService.ts` loads `.troverules` from workspace roots and watches for changes; proxies symbol/outline/search methods to main process.
- Profile and search results injected into the stable system prompt and tool handlers.

---

## 9. Checkpoints and inline diffs

`editCodeService.ts` tracks `DiffArea` per file. On each user message and agent edit, `chatThreadService` records a `checkpoint` with `VoidFileSnapshot` maps.

Users can:

- Accept/reject individual hunks in the editor
- Rewind to a checkpoint (restores snapshots)
- Approve/reject all pending changes from the delivery output panel

This is Trove’s undo model for agent edits — edits apply to live editor models, not a shadow workspace.

---

## 10. Agent delivery (`agentDeliveryService.ts`)

After terminal tool runs, delivery logic inspects output for:

- Build/compile/test success patterns
- Dev server start (`run_persistent_command`, npm/yarn dev scripts)
- Localhost URLs in stdout

Produces `AgentDeliverySummary` (`build_succeeded` \| `server_running` \| `verified`) rendered in `AgentDeliverySummary.tsx` as a **glass output panel**:

- Preview URL as primary display (click to open in workspace Simple Browser)
- **Approve / Reject** for all pending workspace diffs
- No caption headline — content-first layout

Preview opens via `trove.openWorkspacePreview` → `simpleBrowserOpen.ts` (activates built-in Simple Browser extension in the primary editor column).

`workspacePreviewService.ts` debounces reload (250ms) when web assets (HTML/CSS/JS) change on disk. `previewProbeChannel.ts` in main process probes localhost URLs when renderer CSP would block fetch.

---

## 11. Structured plans (`agentPlan.ts`)

Before the main tool loop (agent mode), a separate lightweight LLM call produces 3–7 bullet steps (`PlanMessage`). As tools complete, items move to `done` or `skipped`. Rendered by `PlanView.tsx`.

Uses `PLAN_OUTPUT_TOKEN_CAP` (300) so it does not consume main loop budget.

### Plan item matching

`markPlanItemDoneForTool` scores pending items against each tool call:

- **Tool categories** — read, search, edit, create, run, delete (mapped from builtin tool names).
- **File basename** — strong match when the plan text mentions the target file or stem.
- **Verb heuristics** — category-specific verbs (e.g. read/open/inspect, edit/save, verify/test for run tools).
- **Token overlap** — fallback scoring on path/query tokens from `getToolSummaryForPlanMatch`.

Edit tools can mark multiple pending items when file + edit/save verbs align. Run tools with a file target can match verify-style steps. When no score clears the threshold, falls back to loose text match or the first pending item.

When an agent run finishes successfully, `completeRemainingPlanItems` marks any still-pending steps as `done` (previously they were skipped mid-loop). Interrupted runs still use `skipRemainingPlanItems`.

---

## 12. Chat memory intent (`chatMemoryIntent.ts`)

Natural-language remember requests are detected before the agent loop:

- Patterns: “remember that …”, “don’t forget …”, “save to memory: …”, etc.
- **Remember-only** messages append to `trove-memory.md` and return a confirmation without invoking the LLM.
- Messages with a memory clause *and* a follow-on task still go through the full agent.

---

## 13. Autocomplete

`autocompleteService.ts` sends FIM (fill-in-the-middle) requests to the configured Autocomplete model.

`autocompleteCodebaseContext.ts` optionally:

1. Extracts import hints from the current file
2. Queries repo intelligence search
3. Prepends top snippets as comments in the FIM prefix

---

## 14. Context gathering

`contextGatheringService.ts` caches recently viewed code regions. Snippets can be injected into chat context via `convertToLLMMessageService` (registered in `trove.contribution.ts`).

---

## 14a. Repository Intelligence Analysis Flow (RIAF)

RIAF is a dedicated deep-analysis workflow separate from normal agent chat:

1. User triggers **Analyse Repository** (`analyseRepositoryAction.ts`, `Cmd+Shift+K`).
2. `riafAgentRunController.ts` runs an agent loop with elevated limits (40 iterations, 50 read-only calls).
3. Output is written to `{repo}_context.md` in the workspace.
4. `ContextDocPanel.tsx` surfaces progress and the resulting document.

Prompts and types live in `common/riaf/`. Service: `riafAgentService.ts`.

---

## 15. IPC channel registry

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `trove-channel-llmMessage` | browser ↔ main | LLM send, abort, model list |
| `trove-channel-repoIntelligence` | browser → main | Profile, refresh, codebase search, symbol outline/search |
| `trove-channel-scm` | browser → main | Git commit, branch helpers |
| `trove-channel-metrics` | browser → main | Telemetry events |
| `trove-channel-mcp` | browser ↔ main | MCP discovery and tool calls |
| `trove-channel-update` | browser → main | Update check/install |
| `trove-channel-previewProbe` | browser → main | Localhost readiness probe for workspace preview |

**Convention:** add methods to existing channels rather than creating new channels when possible.

Web search uses `IRequestService` in the browser (Tavily HTTPS) — not a separate IPC channel.

---

## 16. React UI

Built with React + Tailwind (`browser/react/`). Entry bundles:

| Bundle | Mount point |
|--------|-------------|
| `sidebar-tsx` | Chat sidebar (`SidebarChat.tsx`, `PlanView.tsx`, `AgentDeliverySummary.tsx`, `ChatActivityUI.tsx`) |
| `trove-settings-tsx` | Settings pane (models, token economy, web search) |
| `trove-onboarding` | First-run onboarding |
| `quick-edit-tsx` | Ctrl+K widget |
| `diff` | Inline diff UI |

### UI patterns

- **`glass-card` / `glass-panel`** — frosted glass morphism (`styles.css`)
- **`trove-output-panel`** — delivery summary with approve/reject actions
- **`trove-assistant-summary-prose`** — polished committed assistant markdown output
- **`assistantMarkdownNormalize.ts`** — converts agent `**Step N — file:**` headers to styled `h3` headings (bundled in React, not external util)
- **Streaming assistant markdown** — uncommitted messages use `ChatMarkdownRender` (not raw pre-wrap) so step headers render during streaming
- **`CollapsibleCodeSnippet`** — expandable search/read results in chat
- **`BackgroundActivityPanel`** — live idle/LLM activity with status text
- **`AgentTurnCompleteSummaryCard`** — post-turn recap with color-coded activity chips (read/edit/search/run) and touched files
- **Thread rename** — `SidebarThreadSelector.tsx` inline rename; `chatThreadService.renameThread()` persists optional `title` on each thread

Build:

```bash
npm run buildreact      # one-shot
npm run watchreact      # watch mode
```

Output goes to `browser/react/out/` and is synced to `out/vs/workbench/contrib/trove/browser/react/out/`.

---

## 17. Settings and memory

| Mechanism | Location | Loaded by |
|-----------|----------|-----------|
| Trove Settings UI | VS Code storage | `troveSettingsService.ts` |
| `.troverules` | Workspace root | `repoIntelligenceService.ts` |
| `trove-memory.md` | `<userData>/trove-memory.md` | Main repo intelligence / prompts |
| Global AI instructions | Settings | `convertToLLMMessageService.ts` |
| `enablePromptCache` | Settings → Agent & token economy | `sendLLMMessageService.ts` |
| `enableWebSearch` / `webSearchApiKey` | Settings → Agent & token economy | `webSearchService.ts` |

Path helper: `common/troveMemoryPaths.ts`.

### Default model lists (`modelCapabilities.ts`)

Trove ships at most **`MAX_DEFAULT_MODELS` (4)** curated defaults per cloud provider. When the app loads or defaults change:

1. **`stateWithMergedDefaultModels`** — swaps in new default IDs, drops removed ones, preserves `isHidden` and custom models.
2. **`pruneStaleOverridesOfModel`** — removes per-model overrides for models no longer in the active list.
3. **`validatedModelState`** — remaps feature selections (Chat, Ctrl+K, etc.) when the selected model was pruned.

Helpers are exported from `troveSettingsService.ts` for testing (`modelSettingsMerge.test.ts`).

---

## 18. Registration and startup

`trove.contribution.ts` is imported by the workbench and side-effect-imports every service. Order matters for some dependencies (e.g. `editCodeService` before chat, `toolsService` before `chatThreadService`).

Common services (`sendLLMMessageService`, `troveSettingsService`, `IWebSearchService`) are registered as singletons and imported for DI registration side effects.

---

## 19. Extending Trove

### Add a builtin tool

1. Add param/result types in `common/toolsServiceTypes.ts`.
2. Add tool metadata in `common/prompt/prompts.ts` → `builtinTools`.
3. Implement `validateParams`, `callTool`, `stringOfResult` in `browser/toolsService.ts`.
4. Set `approvalType` if user confirmation is required.
5. If read-only and batchable, add to `parallelReadToolBatch.ts` allowlist.
6. If large output, add to `toolResultCompaction.ts` compactable set.
7. Add tests if logic is non-trivial.

### Add a new chat message type

1. Extend union in `common/chatThreadServiceTypes.ts`.
2. Handle persistence implications (storage migration).
3. Add renderer branch in `SidebarChat.tsx` (and related components).

### Add main-process capability

1. Implement in `electron-main/`.
2. Expose via existing IPC channel or new channel registered in `app.ts`.
3. Add browser proxy in `common/` or `browser/`.

### Cross-process rule

Never call Node or `fetch` for LLM from the browser. Never manipulate editor models from main process.

---

## 20. Testing

| Area | Location |
|------|----------|
| Trove unit tests | `npm run test-trove` — 31 files under `browser/test/` and `electron-main/repoIntelligence/test/` |
| Token economy tests | `wireMessageTrim.test.ts`, `toolResultCompaction.test.ts`, `promptCache.test.ts`, `llmMessageUsage.test.ts`, `fileReadDedup.test.ts`, `agentOutputTokenLimits.test.ts`, `llmRateLimit.test.ts` |
| Agent guardrails | `agentEditHints.test.ts`, `agentEditCompletionHints.test.ts`, `agentEditDiagnostics.test.ts`, `agentReadHints.test.ts`, `agentVerificationHints.test.ts`, `agentLoopSettings.test.ts`, `anthropicConversationWire.test.ts` |
| Symbol / DB | `codeChunker.test.ts` (includes legacy KG migration) |
| RIAF | `riafAgentService.test.ts`, `riafIntegration.test.ts`, `riafPrompts.test.ts` |
| Model settings merge | `modelSettingsMerge.test.ts` |
| Agent plan tests | `agentPlan.test.ts` |
| Memory intent tests | `chatMemoryIntent.test.ts` |
| VS Code suite | `npm run test-node`, `npm run test-browser` |
| Layer checker | `npm run valid-layers-check` |

---

## 21. Relationship to VS Code

Trove inherits from VS Code OSS 1.99.x (`package.json` version). Upstream provides:

- Editor, terminal, SCM, extensions, debugging, remote
- Build pipeline (`gulp`, `build/`)
- Extension host and marketplace compatibility

Trove-specific changes are concentrated in `contrib/trove/` plus channel registration in `electron-main/app.ts` and product branding in `product.json`.

---

## 22. Further reading

| Document | Content |
|----------|---------|
| [README.md](README.md) | Build instructions, prerequisites, data paths |
| [TROVE_FEATURES.md](TROVE_FEATURES.md) | Detailed feature reference (tools, token economy, UI, settings) |
| [trove_v1_implementation_plan_kg_token.md](trove_v1_implementation_plan_kg_token.md) | Token optimization + symbol index implementation plan |
| [browser/react/README.md](src/vs/workbench/contrib/trove/browser/react/README.md) | React build constraints |
| [VS Code wiki](https://github.com/microsoft/vscode/wiki/How-to-Contribute) | Upstream compile/debug guidance |
