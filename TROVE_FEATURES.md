# Trove Features Reference

This document is the detailed feature guide for Trove — an AI-native code editor built on VS Code OSS. For system design and process boundaries, see [ARCHITECTURE.md](ARCHITECTURE.md). For build and setup, see [README.md](README.md).

**Product version:** `troveVersion` in [`product.json`](product.json) (currently 1.4.9).

---

## Table of contents

1. [Product overview](#1-product-overview)
2. [Chat modes and the agent loop](#2-chat-modes-and-the-agent-loop)
3. [Built-in tools](#3-built-in-tools)
4. [Token economy and context management](#4-token-economy-and-context-management)
5. [Repo intelligence and symbol index](#5-repo-intelligence-and-symbol-index)
6. [Agent guardrails and hints](#6-agent-guardrails-and-hints)
7. [Structured plans and delivery](#7-structured-plans-and-delivery)
8. [Inline editing, checkpoints, and diffs](#8-inline-editing-checkpoints-and-diffs)
9. [Terminal and workspace preview](#9-terminal-and-workspace-preview)
10. [Autocomplete and quick edit](#10-autocomplete-and-quick-edit)
11. [Web search and MCP](#11-web-search-and-mcp)
12. [LLM providers and wire formats](#12-llm-providers-and-wire-formats)
13. [Memory, rules, and personalization](#13-memory-rules-and-personalization)
14. [Repository Intelligence Analysis Flow (RIAF)](#14-repository-intelligence-analysis-flow-riaf)
15. [User interface](#15-user-interface)
16. [Settings reference](#16-settings-reference)
17. [Data paths and persistence](#17-data-paths-and-persistence)
18. [Testing](#18-testing)

---

## 1. Product overview

Trove is not a VS Code extension. It is a **workbench contribution** compiled into the editor binary with privileged access to the file system, terminal, SQLite database, and main-process HTTP for LLM calls.

What that means in practice:

| Capability | How Trove delivers it |
|------------|----------------------|
| Multi-turn coding agent | LLM ↔ tool loop in `chatThreadService.ts` |
| Inline diffs with undo | Live editor models + checkpoint snapshots |
| Codebase awareness | SQLite FTS index + symbol extraction in main process |
| Multi-provider LLM | Anthropic, OpenAI, Gemini, Ollama, OpenRouter, and more |
| VS Code compatibility | Extensions, debugging, SCM, terminal — unchanged upstream |

All Trove-specific code lives under `src/vs/workbench/contrib/trove/` in three layers:

- **`common/`** — types, prompts, settings schemas (no I/O)
- **`browser/`** — workbench services, tool execution, React UI mount points
- **`electron-main/`** — LLM HTTP, SQLite, MCP main side

---

## 2. Chat modes and the agent loop

### Chat modes

| Mode | Tools available | Typical use |
|------|-----------------|-------------|
| **Agent** | All built-in tools + MCP | Implement features, run tests, edit files |
| **Gather** | Read and search only | Explore codebase without edits |
| **Normal** | None | Plain LLM chat |

Mode is selected in the chat sidebar and stored in Trove Settings (`chatMode`).

### Agent loop flow

When you send a message in Agent mode:

1. **Memory intent check** — “Remember that …” may save to `trove-memory.md` without invoking the LLM.
2. **Optional plan generation** — a lightweight LLM call produces 3–7 checklist steps (if `enableAgentPlan` is on).
3. **Run context build** — stable + volatile system blocks assembled once per run.
4. **Main loop** — repeat until the model stops calling tools or limits are hit:
   - Prepare messages (trim, compact stale tools, wire elision)
   - Send to LLM with prompt caching when enabled
   - If tool calls returned: validate → optional user approval → execute → append results
   - Optional parallel read batching for discovery reads
   - Inject agent hints when patterns suggest the agent is stuck
5. **Finalize** — delivery summary, checkpoint, token usage log.

### Loop limits (configurable in Settings → Agent & token economy)

| Setting | Default | Purpose |
|---------|---------|---------|
| `maxAgentIterations` | 25 | Maximum LLM turns per user message |
| `maxReadOnlyCalls` | 12 (6 in light agent) | Cap on read/search tool calls |
| `maxConsecutiveToolFails` | 3 | Stop after repeated tool errors |
| `llmStreamStallTimeoutMs` | 60,000 (300,000 during edit streaming) | Abort hung streams |

### Idle and streaming status

While the agent runs, the UI shows live status: planning, waiting for model, executing tools, parallel reads, etc. (`ThreadStreamState` + `idleStatus` in `chatThreadService.ts`).

### Tool approval

Destructive or sensitive operations require user approval unless auto-approve is enabled:

- File edits (`edit_file`, `rewrite_file`, create/delete)
- Terminal commands
- MCP tool invocations

Gather mode excludes these tools entirely from the prompt.

---

## 3. Built-in tools

Tools are declared in `common/prompt/prompts.ts` and implemented in `browser/toolsService.ts`.

### Read and search

| Tool | What it does |
|------|--------------|
| `read_file` | Read file contents; optional line range. Duplicate full-range reads within a run are skipped. |
| `get_file_outline` | Structural outline of a file — symbols and line ranges (~50 tokens). **Preferred first step for large files.** |
| `get_symbol` | Source of one named symbol by file + line range (~100–300 tokens). |
| `search_symbols` | FTS search for functions, classes, types, etc. across the workspace. |
| `ls_dir` | List directory entries. |
| `get_dir_tree` | Tree view of a folder (cached per run; invalidated on edits). |
| `search_pathnames_only` | Find files by filename pattern. |
| `search_for_files` | Content search (substring or regex). |
| `search_codebase` | FTS5-ranked semantic search over indexed code chunks. |
| `search_in_file` | Line numbers matching a query in one file. |
| `search_web` | Live web search via Tavily (requires API key). |
| `read_lint_errors` | Linter diagnostics for a file. |

**File-reading policy** (injected in the stable system prompt for Agent mode): for files over 100 lines, prefer `get_file_outline` → `get_symbol` → ranged `read_file` before reading the entire file.

### Edit

| Tool | What it does |
|------|--------------|
| `create_file_or_folder` | Create a new path. |
| `delete_file_or_folder` | Delete; optional recursive. |
| `edit_file` | SEARCH/REPLACE blocks for surgical edits. |
| `rewrite_file` | Replace entire file contents. |

### Terminal

| Tool | What it does |
|------|--------------|
| `run_command` | One-shot shell command with output capture. |
| `run_persistent_command` | Run in a persistent terminal (dev servers). |
| `open_persistent_terminal` | Open a new persistent terminal. |
| `kill_persistent_terminal` | Close a persistent terminal. |

### Parallel read batching

When enabled (`enableParallelReadBatching`), the agent may issue a lightweight discovery LLM call to collect up to four additional read-only tool calls, then execute them in parallel before the next main turn. Supported tools include `read_file`, `search_codebase`, `search_web`, `get_file_outline`, `get_symbol`, and `search_symbols`.

---

## 4. Token economy and context management

Trove is designed for long multi-turn agent sessions without runaway input token costs.

### Stable vs volatile system prompt split

The system prompt is split so Anthropic prompt caching stays effective when you switch files:

| Block | Contents | Cached? |
|-------|----------|---------|
| **Stable** | OS info, mode rules, tool definitions, repo profile, `.troverules`, user memory, file-reading policy | Yes (1h TTL) |
| **Volatile** | Active file, open files, directory tree, persistent terminal IDs | No — sent as separate uncached block |

Implemented in `chat_systemMessage_stable` / `chat_systemMessage_volatile` (`common/prompt/prompts.ts`) and threaded through `convertToLLMMessageService.ts`.

### Prompt caching

When **Prompt cache** is enabled in Settings:

- **Native Anthropic** — three cache breakpoints: stable system, tools array, conversation prefix (second-to-last user message). Volatile system is uncached.
- **Routed Claude** (OpenRouter, Bedrock, LiteLLM, Azure) — stable block cached via `applyRoutedAnthropicPromptCache`; volatile appended uncached.
- **OpenAI** — `prompt_cache_key: trove:${threadId}:${modelName}` for automatic prefix cache routing.

Agent mode uses extended output (`output-128k` beta) without the legacy prompt-caching beta header.

Healthy sessions should show **60–80% of input tokens served from cache** after turn 2 when caching is enabled.

### Tool result compaction

Read/search tool results are marked `compactable: true`. On later turns, stale bodies outside the protected tail are replaced with one-line references like:

`read_file(path) → <42 lines, lines 1-42>; re-read if needed`

The last two tool results and the latest read per file stay full.

### Wire-level elision

Before HTTP send, `wireMessageTrim.ts` drops oldest tool bodies to fit a character budget, preserving recent context.

### Context window trimming

When history exceeds the model context window, `contextWindowTrim.ts` drops oldest messages while protecting the last two user turns.

### File read deduplication

Within a single agent run, `shouldSkipDuplicateFileRead` skips `read_file` only when the requested line range is **fully covered** by a prior read — allowing targeted range reads of unseen sections.

### Rate limiting and retries

- Per-provider input token caps (e.g. Anthropic 22k/min heuristic)
- Parses `retry-after` and Anthropic reset headers
- Retries with aggressive context trim after rate limits
- Exponential backoff via `getLLMRetryDelayMs`

### Output token limits

Agent mode requests up to **32,768 output tokens** on Anthropic with truncation detection (`agentOutputTokenLimits.ts`).

### Usage metering

Each LLM response includes normalized usage (input, output, cache read/write). Per-run totals are logged as `[Trove agent token usage] …` when the run completes. Settings UI shows cost estimates via `usageMeteringService.ts`.

---

## 5. Repo intelligence and symbol index

Workspace understanding runs in the **Electron main process** using SQLite, exposed via IPC channel `trove-channel-repoIntelligence`.

### What gets indexed

1. **Workspace scan** — languages, frameworks, package managers, build/test/start commands.
2. **Code chunks** — files split into ~80-line chunks for `search_codebase` (FTS5 BM25).
3. **Symbols** — functions, classes, interfaces, types, enums with signatures, docstrings, and line ranges for `get_file_outline`, `get_symbol`, `search_symbols`.
4. **LLM summaries** — `projectPurpose` and `architectureSummary` (cached 24h).

### Incremental indexing

Each file has a SHA-256 `content_hash` in `file_metadata`. Only changed files are re-chunked and re-symbolized on refresh.

### SQLite schema (v2)

| Table | Purpose |
|-------|---------|
| `workspace_profiles` | Stack, frameworks, commands, LLM summaries |
| `file_metadata` | Per-file language, mtime, size, `content_hash` |
| `code_chunks` + `chunks_fts` | Semantic codebase search |
| `symbols` + `symbols_fts` | Named symbol index |

Database path: `<userData>/User/globalStorage/trove-repo-intelligence.db`

Legacy knowledge-graph schemas (pre-v2 with `symbol_id`, edges, embeddings) are automatically migrated on startup.

### Browser-side integration

- Repo profile injected into stable system prompt
- `.troverules` loaded and watched from workspace roots
- Indexing status shown in the workbench (`repoIntelligenceStatusContribution.ts`)

---

## 6. Agent guardrails and hints

Trove injects `<agent_hints>` tail messages when the agent shows unproductive patterns. Hints are appended in an Anthropic-safe way (`anthropicConversationWire.ts`) so the conversation always ends on a user role before the next LLM call.

| Hint | Trigger | File |
|------|---------|------|
| Repeat edit | Same file edited ≥2 times | `agentEditHints.ts` |
| Large file edit | File ≥3000 chars; avoid `rewrite_file` | `agentEditHints.ts` |
| Repeat read/search | Duplicate read-only tool signature ≥2× | `agentReadHints.ts` |
| Repeat file read | Same file read ≥2× | `fileReadDedup.ts` |
| Exploration budget | After `maxReadOnlyCalls` read/search calls | `agentReadHints.ts` |
| Sandbox verification | Edits made but no verify command run | `agentVerificationHints.ts` |
| Edit completion | Edit intent but no edits applied (truncation) | `agentEditCompletionHints.ts` |

Edit pipeline stages are logged with `[Trove edit]` prefix for debugging (`agentEditDiagnostics.ts`).

---

## 7. Structured plans and delivery

### Agent plans

Before the main tool loop (when enabled), a separate lightweight LLM call produces a checklist (`PlanMessage`). As tools complete, items move to `done` or `skipped` via smart matching (`agentPlan.ts`):

- Tool category (read, search, edit, create, run, delete)
- File basename overlap
- Verb heuristics (read/open/inspect, edit/save, verify/test)
- Token overlap fallback

When a run finishes successfully, remaining pending items are auto-completed.

### Agent delivery

After terminal runs, `agentDeliveryService.ts` inspects output for:

- Build/compile/test success
- Dev server start patterns
- Localhost URLs in stdout

Produces a **delivery summary** rendered in the chat:

- Preview URL (click to open Simple Browser)
- **Approve / Reject** for all pending workspace diffs
- Status: `build_succeeded`, `server_running`, or `verified`

---

## 8. Inline editing, checkpoints, and diffs

Agent edits apply to **live editor models**, not a shadow workspace.

- **`editCodeService.ts`** tracks diff areas per file with accept/reject per hunk.
- **Checkpoints** snapshot file state on each user message and agent edit.
- **Rewind** restores snapshots from any checkpoint in the thread.
- **Delivery panel** can approve or reject all pending changes at once.

Quick Edit (`Ctrl+K`) uses a focused LLM prompt on the current selection.

---

## 9. Terminal and workspace preview

### Persistent terminals

Dev servers run in persistent terminals that survive across agent turns. Terminal IDs are included in the volatile system prompt so the agent knows what's running.

### Workspace preview

When a dev server reports ready (localhost URL in terminal output):

1. Trove opens the URL in the built-in **Simple Browser** (`simpleBrowserOpen.ts`).
2. Web asset edits (HTML/CSS/JS) trigger debounced reload (250ms) via `workspacePreviewService.ts`.
3. **Preview probe IPC** (`previewProbeChannel.ts`) checks server readiness from main process (bypasses renderer CSP).

Command: `trove.openWorkspacePreview`

---

## 10. Autocomplete and quick edit

### Autocomplete

Fill-in-the-middle completions from the configured Autocomplete model (`autocompleteService.ts`).

Optional **codebase context** (`autocompleteCodebaseContext.ts`):

1. Extract import hints from the current file
2. Query repo intelligence search
3. Prepend top snippets as comments in the FIM prefix

Toggle: `enableAutocomplete`, `enableAutocompleteCodebaseContext`

### Quick Edit (Ctrl+K)

Inline edit widget for the current selection — separate from the full agent loop.

---

## 11. Web search and MCP

### Web search

`search_web` tool uses [Tavily](https://tavily.com) HTTPS API from the browser process (`webSearchService.ts`). Requires `enableWebSearch` and `webSearchApiKey` in Settings.

### MCP (Model Context Protocol)

MCP tools are discovered at runtime and merged into the agent tool list when `chatMode === 'agent'`. MCP calls go through `trove-channel-mcp` with optional user approval.

---

## 12. LLM providers and wire formats

### Supported providers

Anthropic, OpenAI, Gemini, Ollama, vLLM, LM Studio, LiteLLM, DeepSeek, OpenRouter, Groq, Mistral, xAI, Google Vertex, AWS Bedrock, Microsoft Azure, and OpenAI-compatible endpoints.

Each feature (Chat, Autocomplete, Apply, SCM) can use a different model.

### Wire format handling

- **Native tool_use** for Anthropic and capable OpenAI models
- **XML tool definitions** for models without native tool support (`prompts.ts`, `extractGrammar.ts`)
- **Anthropic conversation preflight** — ensures conversation ends on user role; uses `(continue)` placeholder when needed (`anthropicConversationWire.ts`)
- **Routed Claude over OpenAI wire** — prompt cache blocks for OpenRouter/Bedrock paths (`promptCache.ts`)

LLM HTTP runs only in the main process (`sendLLMMessage.impl.ts`). Browser code uses IPC via `sendLLMMessageService.ts`.

---

## 13. Memory, rules, and personalization

| Mechanism | Location | Loaded by |
|-----------|----------|-----------|
| Trove Settings UI | VS Code storage | `troveSettingsService.ts` |
| `.troverules` | Workspace root | `repoIntelligenceService.ts` |
| `trove-memory.md` | `<userData>/trove-memory.md` | Prompts + repo intelligence |
| Global AI instructions | Settings | `convertToLLMMessageService.ts` |
| Remember This action | Command palette | `rememberThisAction.ts` |
| Natural-language remember | Chat patterns | `chatMemoryIntent.ts` |

Examples of remember-only messages (no LLM call): “Remember that this API runs on port 3000”, “Don't forget we use pnpm”.

---

## 14. Repository Intelligence Analysis Flow (RIAF)

RIAF is a dedicated deep-analysis mode for generating a repository context document.

- **Trigger:** “Analyse Repository” action (`Cmd+Shift+K`) — `analyseRepositoryAction.ts`
- **Output:** `{repo}_context.md` in the workspace
- **Elevated limits:** 40 iterations, 50 read-only calls (`riafAgentRunController.ts`)
- **UI:** Context doc panel in sidebar (`ContextDocPanel.tsx`)

Prompts and types: `common/riaf/riafPrompts.ts`, `common/riaf/riafTypes.ts`

---

## 15. User interface

### Chat sidebar (`SidebarChat.tsx`)

- Multi-thread chat with inline rename
- Glass morphism surfaces (input, tool cards, assistant output, delivery panel)
- Collapsible code snippets for search/read results
- Plan checklist view (`PlanView.tsx`)
- Turn complete summary card with activity chips

### Streaming UX

- Assistant messages render as markdown while streaming (not raw pre-wrap text)
- Step headers normalized from `**Step N — file:**` to styled headings (`assistantMarkdownNormalize.ts`)
- Live reasoning block when model supports it
- Per-block edit progress during SEARCH/REPLACE streaming (`liveEditStreaming.ts`, `ChatActivityUI.tsx`)
- Background activity panel with idle/LLM status

### Other UI surfaces

| Surface | Purpose |
|---------|---------|
| Trove Settings | Models, API keys, token economy, web search |
| Onboarding | First-run setup |
| Quick Edit widget | Ctrl+K inline edit |
| Diff widgets | Accept/reject hunks in editor |
| Editor watermark | Chat / Quick Edit shortcuts |
| Usage dashboard | Token cost tracking |

### React build

UI bundles are built with `npm run buildreact` / `npm run watchreact`. Output syncs to `out/vs/workbench/contrib/trove/browser/react/out/`. See [react README](src/vs/workbench/contrib/trove/browser/react/README.md).

---

## 16. Settings reference

### Agent & token economy

| Setting | Default | Description |
|---------|---------|-------------|
| `enablePromptCache` | on | Anthropic/routed prompt caching |
| `enableAgentPlan` | on | Pre-turn checklist generation |
| `enableLightAgent` | off | Reduced context and exploration caps |
| `enableParallelReadBatching` | on | Batch discovery reads |
| `enableWebSearch` | off | `search_web` tool |
| `webSearchApiKey` | — | Tavily API key |
| `maxAgentIterations` | 25 | Loop cap |
| `maxReadOnlyCalls` | 12 | Read/search cap |
| `maxConsecutiveToolFails` | 3 | Error streak cap |
| `llmStreamStallTimeoutMs` | 60000 | Stream timeout |

### Auto-approve

| Setting | Description |
|---------|-------------|
| `autoApprove.edits` | Skip edit approval prompts |
| `autoApprove.terminal` | Skip terminal approval prompts |
| `autoApprove.mcp` | Skip MCP approval prompts |
| `autoAcceptLLMChanges` | Auto-apply diffs without review |

### Models

- Up to **4 curated defaults** per cloud provider (`MAX_DEFAULT_MODELS`)
- Custom models and per-model overrides (context window, max tokens)
- Stale overrides pruned when default lists change

---

## 17. Data paths and persistence

| Path | Contents |
|------|----------|
| `~/.trove-editor/` | Production Trove data (`dataFolderName`) |
| `~/Library/Application Support/code-oss-dev/` | Dev build user data (macOS) |
| `~/.config/code-oss-dev/` | Dev build user data (Linux) |
| `%APPDATA%\code-oss-dev\` | Dev build user data (Windows) |
| `<userData>/trove-memory.md` | Persistent user memory |
| `<userData>/User/globalStorage/trove-repo-intelligence.db` | Repo intelligence SQLite |

Chat threads are persisted in VS Code storage. Changing `ChatMessage` shape requires migration.

---

## 18. Testing

Run Trove unit tests:

```bash
npm run compile
npm run test-trove
```

**31 test files** under `src/vs/workbench/contrib/trove/` covering:

- Token economy (wire trim, compaction, prompt cache, dedup, rate limits)
- Agent hints, plans, verification, loop limits
- Anthropic conversation wire
- Symbol extraction and legacy DB migration
- RIAF prompts and integration
- Live streaming UI and edit streaming
- Model settings merge and usage metering

Full VS Code suite: `npm run test-node`, `npm run test-browser`.

---

## Related documents

| Document | Content |
|----------|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process boundaries, IPC, services, extension guide |
| [README.md](README.md) | Build, prerequisites, quick start |
| [trove_v1_implementation_plan_kg_token.md](trove_v1_implementation_plan_kg_token.md) | Token optimization + symbol index implementation plan |
