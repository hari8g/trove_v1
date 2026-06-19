# Trove v1 — Gap Audit of the Current Implementation

> Audited against the freshly pulled `main` (commit `9532e3b`, 2026-06-17) by reading the actual
> files in `src/vs/workbench/contrib/trove`. This lists what is verified-implemented and, in detail,
> what still needs improvement. Ranked by impact.

---

## A. Verified implemented ✅

| Capability | Where | Status |
|---|---|---|
| Anthropic prompt caching | `sendLLMMessage.impl.ts:466,470,506,512` — `cache_control: ephemeral` on system block + last tool, beta header gated by `enablePromptCache` | ✅ matches spec |
| Build prefix once per run | `chatThreadService.ts:1004-1007` `buildRunContext()` → `precomputedSystemMessage`; `convertToLLMMessageService.ts:597,696` | ✅ |
| Trim reserve fix (non-destructive) | `wireMessageTrim.ts` — `computeEffectiveOutputReserve` + `elideOldestToolResultsFirst` (drops oldest tool bodies; **protects system, last 2 user turns, last 3 tools**) | ✅ correct, and safe for caching |
| Tool-result compaction | `toolResultCompaction.ts`; `compactable` flag `chatThreadServiceTypes.ts:17`, set via `isCompactableToolName` `chatThreadService.ts:847` | ✅ |
| Parallel read batching | `chatThreadService.ts:924` `Promise.all`, `_runReadOnlyToolBatch`, gated by `enableParallelReadBatching` (1156) | ✅ |
| Structured plan | `PlanMessage` `chatThreadServiceTypes.ts:51`; `generateAgentPlan` + `markPlanItemDoneForTool/complete/skip`; gated by `enableAgentPlan` | ✅ |
| Rate-limit retry | `llmRateLimit.ts` — 429 detection, `retry-after` honoring, exp. backoff capped 120s; `getMaxLLMRetryAttempts` | ✅ good |
| Repeat-**edit** hint | `agentEditHints.ts` — tracks per-file edit counts, injects batching hint at threshold 2 | ✅ (but see G1) |

The plan call correctly uses its own lightweight `PLAN_SYSTEM_MESSAGE` (`agentPlan.ts:88`) rather than
the big cached prefix — that's the right call (prefix-light), so INV-2 from the prior doc is satisfied.

---

## B. Gaps to fix, ranked

### G1 — [HIGH, fix first] The repeat-edit hint mutates the cached prefix
`chatThreadService.ts:1025-1030`:
```ts
const repeatEditHint = buildRepeatEditHint(fileEditCounts)
...
precomputedSystemMessage: (precomputedSystemMessage ?? '') + repeatEditHint,
```
The hint is appended to the **system message**, which is exactly the region carrying
`cache_control: ephemeral` (and the byte-identical prefix that OpenAI/Gemini/DeepSeek implicit
caching depends on). The moment a file crosses the edit threshold, the system block changes →
**Anthropic cache miss + re-write that turn, and a cache miss on every implicit-cache provider**, and
it shifts again as more files cross the threshold. The mechanism meant to *shorten* loops partially
defeats the caching meant to make them *cheap*. This is the INV-1 violation flagged in the redefined
architecture, now live in code.

**Fix:** inject `repeatEditHint` into the **latest user message** (the tail, after the last cache
breakpoint), never into `precomputedSystemMessage`. The model sees the hint just as effectively; the
prefix stays byte-stable. One-line move with outsized cost impact.

### G2 — [HIGH] No hard iteration cap on the outer loop
`chatThreadService.ts:1011` `while (shouldSendAnotherMessage)` — `nMessagesSent` increments (1015) but
is only ever logged (1020, 1068) and captured in metrics (1209). Both re-arm sites (1171 batch, 1181
single) set `shouldSendAnotherMessage = true` for any non-interrupted tool call. Nothing bounds the
run. This is the structural backstop the "hard loop" goal requires.

**Fix:** `const MAX_AGENT_ITERATIONS = 25`; at the top of the loop, if `nMessagesSent >= MAX`, append
an assistant message ("stopped after N steps") and `break`. Capture an `Agent Loop Done (Max
Iterations)` metric so you can see how often it trips.

### G3 — [HIGH] No exploration budget / repeat detection for reads & searches
The only convergence pressure is the repeat-**edit** hint. Read-only tools (`read_file`,
`search_codebase`, `search_in_file`, `ls_dir`, …) are uncounted and unbounded. This is the precise
cause of your "loop is longer in finding-and-fixing, in spite of indexing" — the model re-reads the
same files and re-runs near-identical searches, and nothing notices.

**Fix:** mirror the edit-hint pattern for reads:
- Track `(toolName + canonicalArgs)` signatures for read-only calls; if the same signature repeats
  ≥2×, inject a tail hint ("you already ran this; use the result you have or act").
- A `MAX_READONLY_CALLS` budget (e.g. 12) after which a tail hint says "stop exploring; act or
  conclude." Put both hints in the user-tail (per G1), not the system prefix.

### G4 — [MED] Tool failures re-arm the loop like successes
`_runToolCall` returns only `{ awaitingUserApproval?, interrupted? }` (`chatThreadService.ts:689`).
An errored tool (not interrupted, not awaiting) falls to `else { shouldSendAnotherMessage = true }`
(1181) — identical to success — so the model can re-issue the same failing call indefinitely.

**Fix:** add `status: 'ok' | 'error'` to the `_runToolCall` / `_runReadOnlyToolBatch` return; track
`consecutiveFails`; break after `MAX_CONSECUTIVE_FAILS = 3` with a surfaced message. Ensure the
failure text is delivered to the model as the tool result so it adapts rather than repeats.

### G5 — [MED] No stream-stall watchdog
`chatThreadService.ts:1069` `await messageIsDonePromise` resolves only on final/error/abort. A
provider that accepts the request and then stalls with no tokens and no error hangs the turn forever
(no token grep match for any watchdog/`Promise.race`/stall timer). Different symptom from a loop, same
user pain: it never returns.

**Fix:** track `lastTokenAt` in `onText`; `Promise.race` the done-promise against a watchdog that
aborts after ~60s of silence and resolves as an `llmError` — which your `llmRateLimit` retry path then
handles cleanly.

### G6 — [MED] Context-overflow isn't a trim-and-retry; fatal errors still retried 3×
`getMaxLLMRetryAttempts` (`llmRateLimit.ts`) only special-cases 429; everything else (including
`context_length_exceeded` and fatal `400/401/403`) gets 3 generic retries. `contextWasTrimmed` is
plumbed (`chatThreadService.ts:203,1026,1055`) but only feeds **UI status**, not a retry decision.
So an auth/bad-request error wastes 3 attempts, and a hard context-overflow retries identically and
fails identically.

**Fix:** classify errors in `llmRateLimit.ts`:
- fatal (`400` non-context, `401`, `403`, `404`) → 0 retries, fail fast with a clear message;
- `context_length_exceeded`/token-limit → set a `forceAggressiveTrim` flag, retry **once** (your
  proactive trim makes this rare, but it should degrade gracefully when it happens);
- transient (`429`, `5xx`, network, stall from G5) → existing backoff.

### G7 — [VERIFY, potentially HIGH] Confirm `enablePromptCache` is actually turned on
Both `sendAnthropicChat` and `_sendOpenAICompatibleChat` default `enablePromptCache = false`
(`sendLLMMessage.impl.ts:276,479`). All the caching work is dormant unless this is set true upstream
(per-model capability or setting). Verify the live value for the models you run; if it's false, you're
paying full price despite the implementation. Also confirm the OpenAI-compat path's implicit caching
isn't silently broken by anything per-turn (G1 is the known breaker; also keep tool order
deterministic so the prefix hashes identically).

---

## C. Suggested fix order

1. **G1** (move the hint to the tail) — one-line move, immediately restores caching across all providers.
2. **G7** (verify caching is enabled) — confirms G1's payoff is real.
3. **G2** (hard iteration cap) — the safety backstop.
4. **G3** (read/search budget + repeat detection) — directly shortens your find-and-fix loops.
5. **G4** (tool-failure status + cap), **G5** (watchdog), **G6** (error classification) — robustness.

G1–G3 together address both the cost symptom (caching restored) and the "loop runs long" symptom
(exploration bounded), which are the two things you set out to fix.

---

## D. Not gaps (verified fine, noted to avoid re-work)
- Trim protects the system message (`wireMessageTrim.ts` `protectedIndices.add(0)`) — safe for caching.
- Compaction operates on the message tail, not the prefix — safe.
- Plan call is deliberately prefix-light — correct, not a cost regression.
- `.moduleignore` keeps `@vscode/sqlite3`'s `.node` (line 39) — packaging-strip is not the indexing
  cause; if indexing still reads 0 in a packaged build, it's native-ABI rebuild / asar-unpack / the
  `[RepoIntelligence] DB initialized` log, per the prior packaging note — a build concern, not a
  source gap.
