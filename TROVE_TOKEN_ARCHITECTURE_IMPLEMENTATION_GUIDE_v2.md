# Trove v1 — Token Economics Implementation Guide

> Grounded in a direct read of `src/vs/workbench/contrib/trove` at `github.com/hari8g/trove_v1`.
> This guide **supersedes** `TROVE_ARCHITECTURE_ANALYSIS.md` on priorities, because that
> document targets feature gaps while your stated problem is **token exhaustion in the agent loop**.
> Feed this file to Cursor phase-by-phase. Each phase is additive, independently shippable,
> and respects the three-layer boundary.

---

## 0. The single most important finding

Your token problem is **not** any of the nine "future" phases in the old analysis. It has four
concrete causes, in order of impact:

1. **No prompt caching exists anywhere.** `cache_control` appears in *zero* files. The model
   capability type already declares `cost.cache_read` / `cost.cache_write`
   (`common/modelCapabilities.ts:198`), but `sendLLMMessage.impl.ts` sends `system`, `tools`,
   and `messages` as plain payloads with no cache breakpoints. So every loop turn re-bills the
   *entire* static prefix at full input price.

2. **The system prompt is rebuilt and resent on every loop iteration.** In
   `chatThreadService.ts` the agent loop is `while (shouldSendAnotherMessage)` (line 803) and it
   calls `prepareLLMChatMessages(...)` *inside* the loop (line 812). That re-runs
   `_generateChatMessagesSystemMessage` → rebuilds `directoryStr`, the repo profile, and all 14
   XML tool definitions on turn 1, 2, 3 … N. A 10-tool task pays for that prefix ~10 times.

3. **The trim heuristic is economically backwards.** In `convertToLLMMessageService.ts`
   (`prepareOpenAIOrAnthropicMessages`, lines 263-266) it reserves **half the entire context
   window for output**: `reservedOutputTokenSpace = max(contextWindow * 1/2, …)`. On a 200k model
   that throws away 100k of usable input *before any message is added*, then destructively
   slices the largest messages down to 120 chars + "…" (`TRIM_TO_LEN = 120`, line 43). It trims
   content but never the thing actually bloating you — the repeated static prefix.

4. **Tool results are kept verbatim forever.** A `read_file` that dumps 800 lines stays at full
   size in `thread.messages` for the rest of the session and is re-sent every turn. There is no
   compaction of stale tool output.

### What is already done (the old analysis is stale)

Before writing anything, know that these "future phases" are **already in the repo**:

| Old-doc phase | Real status in repo | Evidence |
|---|---|---|
| Phase 1 — ContextGathering + snippets | **Done & wired** | `contextGatheringService.getCachedSnippets()` + `_prependRecentlyViewedCodeToLatestUserMessage` (convertToLLMMessageService.ts:618) |
| Phase 2 — `.troverules` | **Done & wired** | `repoIntelligenceService.getWorkspaceRules()` injected via `chat_systemMessage` (convertToLLMMessageService.ts:576) |
| Phase 3 — Semantic `search_codebase` | **Done & wired** | `code_chunks` + `chunks_fts` FTS5 tables (repoIntelligenceDb.ts:43,54), `codeChunker.ts`, bm25 ranking, `searchCodebase()` over IPC |
| Phase 5 — Parallel read tools | **Not done** | no `Promise.all` in chatThreadService.ts |
| Phase 7 — Structured plan view | **Not done** | no `'plan'` role in chatThreadServiceTypes.ts (this is your "AgentPlanView renders as prose" bug) |

So do **not** re-do Phases 1-3. Spend that effort on token economics first.

---

## 0.9 Caching across ALL 16 providers — the decision

You asked whether to lead with prefix stability (Phase 1) or explicit `cache_control` (Phase 0.5a)
**given you want every provider in the repo to cache.** Answer: **prefix stability comes first.**

There are exactly three chat code paths in `sendLLMMessage.impl.ts`, and all 16 providers map onto
them:

| Code path | Providers it serves | Caching mechanism | Needs `cache_control`? | Needs stable prefix? |
|---|---|---|---|---|
| `sendAnthropicChat` (line 458) | anthropic | **Explicit** — `cache_control: {type:'ephemeral'}` on system + last tool | **Yes** | Yes (markers useless without it) |
| `sendGeminiChat` (line 717) | gemini | **Implicit**, automatic on 2.5+ (min ~1,024 Flash / ~2,048-4,096 Pro tokens), ~90% discount | No | **Yes — the whole mechanism** |
| `_sendOpenAICompatibleChat` (line 273) | openAI, deepseek, vLLM, openRouter, groq, xAI, mistral, lmStudio, liteLLM, googleVertex, microsoftAzure, awsBedrock, openAICompatible | **Implicit/automatic** (OpenAI ≥1024-token identical prefix; DeepSeek identical-from-0th-token; vLLM server-side `--enable-prefix-caching`) | No (except routed-Anthropic — see below) | **Yes** |

**Conclusion:** ~14 of 16 providers cache for free the instant the prefix is byte-identical
turn-to-turn. Only the Anthropic-native path benefits from explicit markers — and even it does
nothing until the prefix is stable. So:

- **Phase 1 (prefix stability) is the universal first move.** It unlocks Gemini + the entire
  OpenAI-compatible bucket with zero per-provider work, and is the precondition for the Anthropic
  markers.
- **Phase 0.5a (explicit `cache_control`) is a thin top-up layer** applied only inside
  `sendAnthropicChat` (and the routed-Anthropic case below) *after* the prefix is stable.

### Per-bucket implementation notes

- **Gemini & OpenAI-compatible bucket:** do nothing in `sendLLMMessage.impl.ts`. Just satisfy
  Phase 1's prefix rules and read the cache-hit counters (`usageMetadata.cachedContentTokenCount`
  for Gemini; `prompt_tokens_details.cached_tokens` for OpenAI-style) added in Phase 0.
- **vLLM / Ollama / LM Studio (self-hosted):** caching is a *server* flag, not an API field. Enable
  vLLM's automatic prefix caching server-side; no client change. Cost is irrelevant (your hardware),
  but it cuts latency, which still matters in the loop.
- **OpenRouter + Claude is the one trap.** OpenRouter routes Claude over the OpenAI wire format, and
  Anthropic ignores `cache_control` placed as a plain system *string* on that path. To cache
  Anthropic-via-OpenRouter you must (1) send the system prompt as a content **block** carrying
  `cache_control`, and (2) rely on OpenRouter's provider **sticky routing** (automatic once a cached
  request is made) so follow-ups hit the same endpoint. For OpenAI/DeepSeek/Gemini *through*
  OpenRouter, caching is automatic on a stable prefix — no markers.
- **awsBedrock / microsoftAzure / googleVertex:** they inherit the upstream model's mechanism —
  Bedrock-Anthropic wants explicit `cache_control`, Azure-OpenAI and Vertex-Gemini are automatic on a
  stable prefix. Since the repo sends them all through `_sendOpenAICompatibleChat`, treat them like
  the OpenRouter case: stable prefix gets you Azure/Vertex caching for free; Bedrock-Anthropic needs
  the content-block marker.

### Prefix-stability rules (what Phase 1 must guarantee)

Automatic caching silently fails if *any* byte of the prefix changes between turns. Enforce:

1. **Static content first, volatile content last.** Order the prompt as:
   `[system identity + rules] → [tool definitions] → [repo profile] → [directory tree] → … → [latest user msg + @snippets]`.
   The first segments must be invariant within a run.
2. **No per-turn regeneration of `directoryStr`** (Phase 1c). A regenerated tree = a new prefix = a
   cache miss every turn, on *every* provider.
3. **No timestamps, UUIDs, or re-sorted tool lists** in the cached region. Tool order must be
   deterministic across turns.
4. **Keep the @recently-viewed snippets at the tail** (the repo already prepends them to the latest
   user message — that's correct; do not move them into the system prefix).
5. **Meet the minimum cacheable size.** Caching only triggers above ~1,024-4,096 tokens depending on
   provider/model. The Trove static prefix (tree + profile + 14 tool defs) is comfortably above this,
   so the prefix qualifies — just don't shrink it below the floor while optimizing.

---

## 1. Existing architecture (verified map)

Three hard zones, unchanged from the old doc and confirmed accurate:

- `electron-main/` — Node, SQLite, the real LLM HTTP calls (`llmMessage/sendLLMMessage.impl.ts`),
  repo intelligence DB.
- `common/` — types, `modelCapabilities.ts`, `prompt/prompts.ts`, IPC type contracts.
- `browser/` — `chatThreadService.ts` (the loop), `convertToLLMMessageService.ts` (message
  assembly + trim), `toolsService.ts`, React UI under `browser/react/src/`.

The request path that matters for tokens:

```
chatThreadService._runChatAgent()                      [browser/chatThreadService.ts:764]
  └─ while (shouldSendAnotherMessage)                  [line 803]
       └─ prepareLLMChatMessages()                     [line 812]  ← rebuilds system msg every turn
            └─ _generateChatMessagesSystemMessage()    [convertToLLMMessageService.ts:555]
                 └─ directoryStrService.getAllDirectoriesStr()   ← expensive, regenerated each turn
                 └─ repoIntelligenceService.getProfileSync()
                 └─ chat_systemMessage(...)            [common/prompt/prompts.ts]
            └─ prepareMessages() → prepareOpenAIOrAnthropicMessages()  ← the trim
       └─ llmMessageService.sendLLMMessage()           [line 837]  via IPC
            └─ sendLLMMessage.impl.ts → anthropic.messages.stream({ system, messages, tools })  [line 487]
```

Every arrow marked "each turn" is a place you are re-paying for identical bytes.

---

## 2. Phased plan (reordered around token cost)

Effort estimates assume you are driving Cursor, not hand-typing. Ship and measure after each phase.

### Phase 0 — Instrumentation first (½ day, do not skip)

You cannot optimize what you cannot see. Add token accounting before changing behavior.

- **0a.** Capture cache + token usage in **all three** chat paths, since the field names differ:
  - `sendAnthropicChat` (line 563 `finalMessage`): `response.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.
  - `_sendOpenAICompatibleChat`: `usage.prompt_tokens_details.cached_tokens` (cache hits) + `prompt_tokens` / `completion_tokens`.
  - `sendGeminiChat`: `usageMetadata.{cachedContentTokenCount, promptTokenCount, candidatesTokenCount}`.
- **0b.** Plumb those numbers back through the existing `onFinalMessage` callback shape (add an
  optional `usage` field to the callback payload type in `common/sendLLMMessageTypes.ts`). Do
  **not** add a new IPC channel — extend the existing `onFinalMessage` event.
- **0c.** In `chatThreadService.ts`, accumulate per-run totals and `console.info` a one-line
  summary at the end of `_runChatAgent`: turns, total input, total output, cache-read ratio.

This gives you a before/after number for every phase below.

---

### Phase 0.5 — Explicit cache markers (Anthropic top-up) (1 day) — **do this AFTER Phase 1**

> Reordered per the all-provider analysis in §0.9: Phase 1 (prefix stability) must land first
> because it's what unlocks Gemini + the entire OpenAI-compatible bucket. This phase is the thin
> explicit-marker layer that only the Anthropic-native (and routed-Anthropic) path needs.

Anthropic charges cache reads at ~10% of input price and caches the prefix for 5 minutes. Your
agent loop is the perfect workload: a large static prefix (system + tools) followed by a growing
tail. Mark the prefix cacheable once and turns 2…N stop costing full price.

**0.5a — Anthropic native (`sendAnthropicChat`).**
In `sendLLMMessage.impl.ts`, change the `anthropic.messages.stream({...})` call (line 487):

- Convert `system` from a plain string to a block array with a trailing cache breakpoint:
  ```ts
  system: separateSystemMessage
    ? [{ type: 'text', text: separateSystemMessage, cache_control: { type: 'ephemeral' } }]
    : undefined,
  ```
- Add a cache breakpoint to the **last** tool in `anthropicTools()` (line 444). Cache control on
  the final tool covers the whole tools array:
  ```ts
  if (anthropicTools.length) {
    anthropicTools[anthropicTools.length - 1] = {
      ...anthropicTools[anthropicTools.length - 1],
      cache_control: { type: 'ephemeral' },
    };
  }
  ```
- Optionally add a breakpoint on the **second-to-last message** so the conversation prefix also
  caches across turns (Anthropic allows up to 4 breakpoints). Start without this; add it once
  0a tells you the message tail is the dominant cost.
- The SDK may require the beta header on older versions; if `cache_read_input_tokens` stays 0,
  pass `betas: ['prompt-caching-2024-07-31']` or upgrade `@anthropic-ai/sdk`.

**0.5b — OpenAI-compatible bucket (openAI, deepseek, groq, xAI, mistral, Azure, Vertex, vLLM…).**
No `cache_control` needed — these cache automatically on an identical prefix once Phase 1 lands.
The only special case is **Anthropic routed through OpenRouter or Bedrock**: send the system prompt
as a content **block** with `cache_control` (not a plain string), because Anthropic ignores the
marker on the OpenAI-wire path. Rely on OpenRouter's sticky routing for cross-turn hits.

**0.5c — Gemini (`sendGeminiChat`).** No `cache_control` needed — implicit caching is automatic on
2.5+ models for an identical prefix once Phase 1 lands. Explicit `cachedContent` is a later, optional
optimization, not now.

**Verification:** rerun a 5-tool task and confirm cache-read counters are large from turn 2 onward
and total billed input drops sharply — check this on *each* provider family you use, since the
mechanism differs per bucket. Feature-flag the Anthropic markers behind a new `FeatureName`.

---

### Phase 1 — Build the static prefix once per run, not once per turn (1 day)

Caching only helps if the prefix is identical turn-to-turn, and you stop *rebuilding* it anyway.

- **1a.** In `chatThreadService._runChatAgent` (line 764), hoist the system-message construction
  **above** the `while (shouldSendAnotherMessage)` loop. Compute `separateSystemMessage` once,
  before line 803.
- **1b.** Split `prepareLLMChatMessages` into two functions in `convertToLLMMessageService.ts`:
  - `buildRunContext(chatMode, modelSelection)` → returns the system message (call once per run).
  - `prepareLLMChatMessages({ ..., precomputedSystemMessage })` → reuses it (call each turn).
  Keep the old signature working by making `precomputedSystemMessage` optional so nothing else
  breaks.
- **1c.** `directoryStr` is the expensive part. Cache it on the service keyed by a cheap
  signature (set of open URIs + workspace mtime). Recompute only when the signature changes, not
  every turn. The agent's own edits *can* change the tree, so invalidate the cache inside the
  terminal/edit tool result path rather than on a timer.

This alone removes the per-turn regeneration cost and makes 0.5b/0.5c (OpenAI/Gemini implicit
caching) actually fire.

---

### Phase 2 — Fix the trim economics (1 day)

The current reserve of `contextWindow * 1/2` for output is the bug. Output is rarely more than
`reservedOutputTokenSpace` (default 4096, or the model's reasoning budget).

- **2a.** In `prepareOpenAIOrAnthropicMessages` (line 263), change the reserve to the *actual*
  output budget, not half the window:
  ```ts
  reservedOutputTokenSpace = reservedOutputTokenSpace ?? 4_096;
  // remove the contextWindow * 1/2 floor
  ```
  Add a small safety margin (e.g. `+ 2_000`) instead of halving the window. On a 200k model this
  reclaims ~96k tokens of usable input.
- **2b.** Replace the destructive "slice to 120 chars" trim with **drop-oldest-tool-results-first**:
  when over budget, elide the *oldest* `role: 'tool'` message bodies (replace with
  `"[earlier tool output omitted to fit context]"`) before touching anything else. Preserve the
  system message, the last 2 user turns, and the most recent 3 tool results. This matches the
  weighting intent already in the code (lines 288-312) but removes information cleanly at message
  granularity instead of corrupting the middle of a file dump.
- **2c.** Keep `CHARS_PER_TOKEN = 4` as the estimate; it's fine. The fix is *what* you trim and
  *how much* you reserve, not the estimator.

---

### Phase 3 — Tool-result compaction (2 days)

`read_file` and search dumps are the largest repeated payload after the system prompt.

- **3a.** When a `read_file` result is added to the thread in `chatThreadService.ts`, store the
  full text for UI display but tag the message with `{ compactable: true }` in
  `chatThreadServiceTypes.ts`.
- **3b.** In `_chatMessagesToSimpleMessages` (convertToLLMMessageService.ts:586), once a tool
  result is older than the **last 2 turns**, replace its wire `content` with a compact reference:
  `read_file(path) → <N lines, lines a-b>; re-read if needed`. The model already has the path and
  can re-read; you stop paying to resend 800 lines it has already used.
- **3c.** This composes with Phase 2: 3b shrinks the tail proactively, 2b is the hard fallback
  when even the compacted tail overflows.

---

### Phase 4 — Parallel read-tool batching (2 days)

Reduces *turn count*, which (combined with caching) is the second multiplier on cost. This is a
real gap — no `Promise.all` exists today.

- **4a.** Define the read-only set in `toolsService.ts`:
  `{'read_file','ls_dir','get_dir_tree','search_pathnames_only','search_for_files','search_in_file','search_codebase'}`.
- **4b.** In `_runChatAgent`, when the model returns a read-only tool call, do **not** loop
  immediately. Issue one cheap follow-up call (`max_tokens: 200`, addendum: "List all additional
  read-only tools you need now, one per line, or DONE") and `Promise.all` up to 4 calls through
  the existing `_runToolCall` unchanged. Add all results before the next full LLM call.
- **4c.** Gate behind a `FeatureName`. Keep destructive tools (edit, terminal) strictly serial.

---

### Phase 5 — Structured plan message type (3-4 days)

This is the fix for your **AgentPlanView-renders-as-prose** bug. The renderer is prose because
there is no structured `plan` message — the agent emits freeform markdown.

- **5a.** Add to the `ChatMessage` union in `chatThreadServiceTypes.ts`:
  ```ts
  { role: 'plan'; items: { text: string; status: 'pending' | 'done' | 'skipped' }[]; threadId: string }
  ```
- **5b.** In `_runChatAgent`, *before* the main loop, make one lightweight call
  (`max_tokens: 300`, "list 3-7 concrete steps, infinitive, list only"). Parse into a `plan`
  message. This call must **not** enter the main message history (so it can't bloat the loop).
- **5c.** Add a renderer **case** for `role: 'plan'` in `SidebarChat.tsx` that draws a checklist;
  flip items to `done` as matching tool calls complete. The component is structured UI, not
  markdown, which removes the prose-rendering problem at the source.

---

### Phase 6+ — Remaining genuine gaps (schedule after token work)

From the old doc, still real and still valuable, but **after** the token fixes land:
multi-file diff review panel (Phase 8), persistent memory file (Phase 9), web search tool,
shadow workspace. None of these reduce token cost; they're feature work. Codebase-aware
autocomplete (old Phase 4) can now reuse the *already-built* `searchCodebase()`.

---

## 3. Recommended order & expected effect

| Order | Phase | Effort | Primary effect |
|---|---|---|---|
| 1 | 0 — Instrumentation | ½ day | Makes everything measurable |
| 2 | 1 — Build prefix once / cache directoryStr / stable ordering | 1 day | **Universal unlock** — turns on Gemini + all OpenAI-compatible caching for free; precondition for everything |
| 3 | 0.5 — Explicit cache markers (Anthropic + routed-Anthropic) | 1 day | Cuts Anthropic input cost ~90% once prefix is stable |
| 4 | 2 — Fix trim reserve | 1 day | Reclaims ~half the context window |
| 5 | 3 — Tool-result compaction | 2 days | Shrinks the repeated tail |
| 6 | 4 — Parallel read batching | 2 days | Cuts turn count |
| 7 | 5 — Structured plan view | 3-4 days | Fixes the prose-rendering bug |

Phases 0, 1, 0.5, and 2 together should resolve the "exhausting tokens easily" symptom across every
provider. Everything after is refinement.

---

## 4. Golden rules (carried forward + new)

1. **Never add a new IPC channel.** Extend existing events (e.g. add `usage` to `onFinalMessage`).
2. **Every new behavior gets a `FeatureName` flag** in `ITroveSettingsService` so you can A/B and
   roll back. Caching and parallel batching especially.
3. **Don't rewrite `_runChatAgent` control flow.** Phases 1-4 inject at the edges (hoist above the
   loop, swap the message-prep input). Only Phase 5 adds a pre-loop step, and it's isolated.
4. **New message types go in `chatThreadServiceTypes.ts` and need a renderer case in
   `SidebarChat.tsx`** — the `plan` type and the `compactable` tag both follow this.
5. **Measure after each phase** with the Phase 0 counters before moving on. If a phase doesn't
   move the cache-read ratio or total input tokens, stop and diagnose before stacking the next.
6. **Caching is identity-sensitive.** Anything that varies the prefix per turn (a timestamp, a
   re-sorted tool list, a regenerated tree) silently disables caching. Keep the cached prefix
   byte-stable.
