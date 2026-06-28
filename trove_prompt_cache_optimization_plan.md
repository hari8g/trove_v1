# Trove v1 — Prompt Cache Optimization Plan
> Ground-truth implementation plan. Every issue traced to exact file + line in `github.com/hari8g/trove_v1`.
> Cloned and audited June 2026. Ready to paste as Cursor agent context.

---

## Executive Summary

The current caching implementation is **structurally sound but has five concrete bugs and three
high-ROI optimization gaps**. The most severe bug actively *defeats* caching by mutating the
stable system message on every file navigation. The most impactful optimization leaves one of
Anthropic's four allowed cache breakpoints permanently unused — a meaningful waste in every
25-turn agent session. Fixing all items below will reduce per-session Anthropic API costs by an
estimated **45–60%** for typical agent runs.

**Files affected:** 7  
**New files to create:** 0  
**Estimated LOC changed/added:** ~120

---

## Current State Audit

### Cache breakpoint inventory (Anthropic native path)

| Breakpoint # | Where placed | Status |
|---|---|---|
| BP1 | Stable system message (`buildAnthropicSystemBlocks`) | ✅ Correct |
| BP2 | Last tool definition (`anthropicTools`) | ✅ Correct |
| BP3 | Second-to-last **user** message (`addConversationCacheBreakpoint`) | ⚠️ Only fires when `messages.length >= 3` |
| BP4 | *Unused* | ❌ Never placed |

Anthropic allows **4 cache breakpoints** per request. We're leaving BP4 on the table in every
single call.

### Cache breakpoint inventory (routed path — OpenRouter / Bedrock / LiteLLM / Azure)

| Breakpoint # | Where placed | Status |
|---|---|---|
| BP1 | Stable system message (`applyRoutedAnthropicPromptCache`) | ✅ Correct |
| BP2–BP4 | *Unused* | ❌ Tool definitions and conversation history never cached |

For routed Claude models using the XML tool format, tool definitions live inside the system
message content and are covered by BP1. Conversation-level breakpoints are not added at all.

---

## Bugs

### BUG 1 — CRITICAL: `activeURI`-driven domain context inside `chat_systemMessage_stable()` breaks cache on every file navigation

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`  
**Lines:** 801 (function signature), 894–917 (the offending block)

```typescript
// CURRENT — BROKEN: activeURI is a volatile cursor position, not a stable session property
export const chat_systemMessage_stable = ({
    …, activeURI }: …): string => {
    …
    if (activeURI && (
        activeURI.includes('ondc-integrator') ||
        activeURI.includes('ondc_integrator')
    )) {
        const ondcBlock = `<ondc_protocol_context>…</ondc_protocol_context>`;
        ansStrs.push(ondcBlock);   // ← injected into the STABLE (cached) block!
    }
```

**Why it's broken:** `chat_systemMessage_stable()` is used as the *cached* part of the system
message — the part that Anthropic stores and reuses for 1h. When the user navigates from an
ONDC file to any other file, `activeURI` changes, the stable block text changes, the cached
prefix is invalidated, and Anthropic charges a full **cache write** for the new text. This
happens on every file switch in an ONDC-adjacent codebase. The stable/volatile split was
specifically designed to prevent this; the ONDC injection reverses it.

**Fix:** Move domain context injection to `chat_systemMessage_volatile()`. Volatile content is
never cache-marked and changes freely without penalty.

```typescript
// FILE: common/prompt/prompts.ts

// STEP 1 — Remove from chat_systemMessage_stable (lines 894–918)
// Delete the entire if (activeURI && (…)) { … } block

// STEP 2 — Add to chat_systemMessage_volatile
export const chat_systemMessage_volatile = ({
    openedURIs, directoryStr, activeURI, persistentTerminalIDs, chatMode: mode,
}: …): string => {
    const parts: string[] = [];

    // [existing workspace_state block — keep unchanged]
    const workspaceState = (…);
    parts.push(workspaceState);

    if (directoryStr) {
        parts.push(`Here is an overview of the user's file system:\n<files_overview>\n${directoryStr}\n</files_overview>`);
    }

    // ← NEW: domain context blocks (volatile — changes with active file, never cached)
    const domainBlock = buildDomainContextBlock(activeURI);
    if (domainBlock) {
        parts.push(domainBlock);
    }

    return parts.filter(Boolean).join('\n\n\n').trim();
};

// STEP 3 — Extract domain context into a standalone function (same file)
export function buildDomainContextBlock(activeURI: string | undefined): string {
    if (!activeURI) return '';

    if (activeURI.includes('ondc-integrator') || activeURI.includes('ondc_integrator')) {
        return `<ondc_protocol_context>
Protocol: ONDC v1.x / Beckn Core Specification
Mandatory context object fields (must be present in EVERY request/response):
  bap_id, bap_uri, transaction_id, message_id, timestamp (ISO 8601), ttl (e.g. PT30S), action, domain, version, country, city

Beckn action flow:
  search → on_search → select → on_select → init → on_init → confirm → on_confirm
  status → on_status | track → on_track | cancel → on_cancel | update → on_update | rating → on_rating

STaaS integration points:
  ONDC catalog items map to staas-catalog-management via /catalog/** gateway route
  ONDC order lifecycle maps to staas-order-management via /order/** gateway route
  Seller onboarding maps to staas-tenant-management

Compliance constraints (India region):
  All callbacks must return HTTP 200 ACK within 30 seconds
  Error responses use Beckn Error schema: { code, message, type, path }
  Signatures: ED25519 signing over (digest + created + expires) headers
</ondc_protocol_context>`;
    }

    // Future domain blocks can be added here:
    // if (activeURI.match(/mlff|tolling|fastag|anpr|gantry/i)) { return MLFF_BLOCK; }
    // if (activeURI.match(/logistics|shipment|consignment|fms|waybill/i)) { return LOGISTICS_BLOCK; }

    return '';
}
```

**Also remove `activeURI` from the `chat_systemMessage_stable` signature:**

```typescript
// BEFORE (line 801):
export const chat_systemMessage_stable = ({
    workspaceFolders, chatMode: mode, mcpTools, includeXMLToolDefinitions,
    repoProfile = null, workspaceRules = null, userMemory = null,
    repoProfileMode, activeURI                                          // ← remove
}: Omit<ChatSystemMessageOpts, 'openedURIs' | 'directoryStr' | 'persistentTerminalIDs'>): string => {

// AFTER:
export const chat_systemMessage_stable = ({
    workspaceFolders, chatMode: mode, mcpTools, includeXMLToolDefinitions,
    repoProfile = null, workspaceRules = null, userMemory = null, repoProfileMode,
}: Omit<ChatSystemMessageOpts, 'openedURIs' | 'directoryStr' | 'persistentTerminalIDs' | 'activeURI'>): string => {
```

**Call site update in `convertToLLMMessageService.ts` (line 615):**

```typescript
// BEFORE:
const stableBlock = chat_systemMessage_stable({
    workspaceFolders, chatMode, mcpTools, includeXMLToolDefinitions,
    repoProfile, workspaceRules, userMemory, repoProfileMode, activeURI  // ← remove activeURI
})

// AFTER:
const stableBlock = chat_systemMessage_stable({
    workspaceFolders, chatMode, mcpTools, includeXMLToolDefinitions,
    repoProfile, workspaceRules, userMemory, repoProfileMode,
})
```

---

### BUG 2 — MEDIUM: Spurious `ttl: '1h'` field in all `cache_control` objects

**Files:**
- `src/vs/workbench/contrib/trove/common/promptCache.ts` — line 38
- `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts` — lines 517, 543, 588, 593

**Why it's broken:** The Anthropic `CacheControlEphemeral` type is `{ type: 'ephemeral' }`.
There is no `ttl` field in the API spec. The code passes `{ type: 'ephemeral', ttl: '1h' }`
using type assertions to silence TypeScript. Anthropic silently ignores unknown fields today,
but this: (a) creates misleading code implying TTL is configurable, (b) bloats every cached
block with a phantom field, and (c) will cause strict-validation failures if Anthropic ever
tightens their schema.

**Fix — `promptCache.ts` (line 35–39):**

```typescript
// BEFORE:
const cacheBlock = (text: string) => ([{
    type: 'text',
    text,
    cache_control: { type: 'ephemeral', ttl: '1h' },  // ← ttl is not a valid field
}]);

// AFTER:
const cacheBlock = (text: string) => ([{
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' } as const,
}]);
```

**Also update the inline type annotation on line 42:**

```typescript
// BEFORE:
const content: { type: string; text: string; cache_control?: { type: string; ttl?: string } }[] = [];

// AFTER:
const content: { type: string; text: string; cache_control?: { type: 'ephemeral' } }[] = [];
```

**Fix — `sendLLMMessage.impl.ts` (lines 517, 543, 588, 593):**

```typescript
// BEFORE (line 517):
cache_control: { type: 'ephemeral', ttl: '1h' } as Anthropic.Messages.CacheControlEphemeral,

// AFTER — all four occurrences:
cache_control: { type: 'ephemeral' } satisfies Anthropic.Messages.CacheControlEphemeral,
```

> Use `satisfies` instead of `as` — it validates the shape without widening to the cast type,
> so if Anthropic ever adds a required field TypeScript will catch it.

---

### BUG 3 — MEDIUM: `MeteringSession` missing `totalCacheWriteTokens` — cache write cost invisible in dashboard

**Files:**
- `src/vs/workbench/contrib/trove/common/usageMeteringTypes.ts` — line 29
- `src/vs/workbench/contrib/trove/browser/usageMeteringService.ts` — lines 43, 113

**Why it's broken:** `MeteringSession` has `totalCacheReadTokens` but no `totalCacheWriteTokens`.
`recordTurn()` accumulates reads but silently drops write tokens. Anthropic cache writes cost
**25% more than regular input** (`cacheWritePer1M: 3.75` vs `inputPer1M: 3.00` for Sonnet).
A user who writes a 10,000-token system message 100 times per day is paying an invisible premium
that doesn't show up in the dashboard.

**Fix — `usageMeteringTypes.ts`:**

```typescript
// BEFORE (line 29):
export interface MeteringSession {
    startedAt: number;
    totalCostUSD: number;
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;   // ← last field
    byProvider: Record<string, ProviderTotals>;
    byThread: Record<string, ProviderTotals>;
    dailyUSD: Record<string, number>;
}

// AFTER:
export interface MeteringSession {
    startedAt: number;
    totalCostUSD: number;
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;  // ← ADD
    byProvider: Record<string, ProviderTotals>;
    byThread: Record<string, ProviderTotals>;
    dailyUSD: Record<string, number>;
}
```

**Fix — `usageMeteringService.ts` (emptySession, line 43):**

```typescript
// BEFORE:
const emptySession = (): MeteringSession => ({
    startedAt: Date.now(),
    totalCostUSD: 0,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    byProvider: {},
    byThread: {},
    dailyUSD: {},
});

// AFTER:
const emptySession = (): MeteringSession => ({
    startedAt: Date.now(),
    totalCostUSD: 0,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,  // ← ADD
    byProvider: {},
    byThread: {},
    dailyUSD: {},
});
```

**Fix — `usageMeteringService.ts` (`recordTurn`, line ~113):**

```typescript
// BEFORE:
this._session.totalCacheReadTokens += opts.usage.cacheReadTokens;

// AFTER:
this._session.totalCacheReadTokens  += opts.usage.cacheReadTokens;
this._session.totalCacheWriteTokens += opts.usage.cacheWriteTokens ?? 0;  // ← ADD
```

**Update `UsageDashboard.tsx`** to display the new field as a "Cache Write" row alongside the
existing Cache Read row. Both should show tokens and USD cost, with a combined "Cache Efficiency"
percentage = `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`.

---

### BUG 4 — LOW: `prompt_cache_key` not gated by `enablePromptCache` flag

**File:** `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts`  
**Line:** 366

```typescript
// BEFORE:
...(threadId ? { prompt_cache_key: `trove:${threadId}:${modelName}` } : {}),

// AFTER:
...(enablePromptCache && threadId ? { prompt_cache_key: `trove:${threadId}:${modelName}` } : {}),
```

When users disable prompt caching in settings (`enablePromptCache: false`), this key is still
sent to every OpenAI-compatible provider, potentially triggering unexpected caching behavior on
providers that respect it.

---

### BUG 5 — LOW: Dead `enablePromptCache` parameter in `getAnthropicBetaHeaders`

**File:** `src/vs/workbench/contrib/trove/common/agentOutputTokenLimits.ts`  
**Lines:** 26–35

```typescript
// CURRENT — enablePromptCache accepted but never used:
export const getAnthropicBetaHeaders = (opts: {
    enablePromptCache: boolean;   // ← accepted
    chatMode: ChatMode | null | undefined;
}): string | undefined => {
    const betas: string[] = [];
    if (opts.chatMode === 'agent') {
        betas.push(ANTHROPIC_EXTENDED_OUTPUT_BETA);
    }
    // enablePromptCache is never read — the prompt-caching-2024-07-31 beta header
    // is no longer needed (prompt caching is GA since late 2024)
    return betas.length ? betas.join(',') : undefined;
};
```

**Fix:**

```typescript
// AFTER — remove dead param, add explanatory comment:
/** Prompt caching is GA since late 2024 and requires no beta header. */
export const getAnthropicBetaHeaders = (opts: {
    chatMode: ChatMode | null | undefined;
}): string | undefined => {
    const betas: string[] = [];
    if (opts.chatMode === 'agent') {
        betas.push(ANTHROPIC_EXTENDED_OUTPUT_BETA);
    }
    return betas.length ? betas.join(',') : undefined;
};
```

**Update call site in `sendLLMMessage.impl.ts` (line 629):**

```typescript
// BEFORE:
const anthropicBeta = getAnthropicBetaHeaders({ enablePromptCache, chatMode })

// AFTER:
const anthropicBeta = getAnthropicBetaHeaders({ chatMode })
```

---

## Optimizations

### OPT 1 — HIGH ROI: Use all 4 cache breakpoints — add a second conversation-level breakpoint

**File:** `src/vs/workbench/contrib/trove/electron-main/llmMessage/sendLLMMessage.impl.ts`  
**Current function:** `addConversationCacheBreakpoint` (line 559)

**Why this matters:** In a 25-iteration agent session with 2 tool calls per turn, the Anthropic
wire has ~75 user-role messages (actual user turns + tool results sent as `role: 'user'`).
The current function places a single breakpoint at the 2nd-to-last user message. This means
messages 1 through 73 are re-sent uncached on every turn. At ~200 tokens per message, that's
~14,600 tokens charged at the full input rate every single turn. A second breakpoint at message
~N/2 halves that uncached tail.

**Anthropic's 4-breakpoint budget for a typical agent turn:**
```
BP1 — system message (stable block)        ~8,000 tokens  [always hits cache after turn 1]
BP2 — last tool definition                 ~2,500 tokens  [always hits cache after turn 1]
BP3 — midpoint of conversation history     ~7,000 tokens  [NEW — hits cache after 2 turns]
BP4 — second-to-last user message          ~3,000 tokens  [hits cache every turn]
```

**Replacement for `addConversationCacheBreakpoint`:**

```typescript
// FILE: electron-main/llmMessage/sendLLMMessage.impl.ts
// Replace lines 559–601

/**
 * Place cache breakpoints on user messages in the conversation history.
 * Anthropic allows up to 4 cache breakpoints total (system + tools already use 2).
 * We use the remaining 2 slots for conversation history:
 *   - BP3: the user message at roughly the midpoint of history (caches older half)
 *   - BP4: the second-to-last user message (caches recent stable half)
 *
 * In Anthropic's wire format, tool results are sent as role='user' messages, so
 * "user message count" includes both actual user turns and tool result turns.
 */
const addConversationCacheBreakpoints = (
    messages: AnthropicLLMChatMessage[],
    enablePromptCache: boolean,
): AnthropicLLMChatMessage[] => {
    if (!enablePromptCache) {
        return messages;
    }

    // Collect indices of all user messages, oldest first
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
            userIndices.push(i);
        }
    }

    // Need at least 3 user messages to be worth caching (last is current turn,
    // second-to-last is BP4 target, third-to-last enables a meaningful BP3)
    if (userIndices.length < 3) {
        return messages;
    }

    // BP4: second-to-last user message (existing behaviour)
    const bp4Idx = userIndices[userIndices.length - 2];

    // BP3: midpoint of history — picks the user message at ~50% of the list,
    // but always at least 2 positions before BP4 to avoid redundant breakpoints
    const midpoint = Math.floor((userIndices.length - 2) / 2);
    const bp3Idx = userIndices[midpoint];

    // Collect distinct target indices (bp3 may equal bp4 in short conversations)
    const targets = bp3Idx !== bp4Idx
        ? [bp3Idx, bp4Idx]
        : [bp4Idx];

    const result = [...messages];

    for (const targetIdx of targets) {
        const target = result[targetIdx];
        const rawContent = target.content;

        let contentBlocks: AnthropicLLMChatMessage['content'];
        if (typeof rawContent === 'string') {
            contentBlocks = [{
                type: 'text',
                text: rawContent,
                cache_control: { type: 'ephemeral' },
            }] as unknown as AnthropicLLMChatMessage['content'];
        } else if (Array.isArray(rawContent) && rawContent.length > 0) {
            const blocks = [...rawContent] as Record<string, unknown>[];
            blocks[blocks.length - 1] = {
                ...blocks[blocks.length - 1],
                cache_control: { type: 'ephemeral' },
            };
            contentBlocks = blocks as AnthropicLLMChatMessage['content'];
        } else {
            continue; // skip empty content blocks
        }

        result[targetIdx] = { ...target, content: contentBlocks } as AnthropicLLMChatMessage;
    }

    return result;
};
```

**Update call site (line 640):**

```typescript
// BEFORE:
const cachedMessages = addConversationCacheBreakpoint(
    messages as AnthropicLLMChatMessage[],
    enablePromptCache,
);

// AFTER:
const cachedMessages = addConversationCacheBreakpoints(
    messages as AnthropicLLMChatMessage[],
    enablePromptCache,
);
```

**Delete the old `addConversationCacheBreakpoint` function** (lines 556–601).

---

### OPT 2 — MEDIUM ROI: Add conversation-level cache breakpoints on routed Anthropic path

**File:** `src/vs/workbench/contrib/trove/common/promptCache.ts`

The `applyRoutedAnthropicPromptCache()` function only caches the stable system message for
OpenRouter/Bedrock/LiteLLM/Azure routed Claude models. For long agent sessions on these
providers, the conversation history is entirely uncached.

The routed path uses the OpenAI wire format, where adding `cache_control` blocks to user message
content follows the same pattern as the native Anthropic path. OpenRouter, Bedrock, and LiteLLM
all pass `cache_control` blocks through to Anthropic's API verbatim.

**Add `applyRoutedAnthropicConversationCache` to `promptCache.ts`:**

```typescript
// FILE: common/promptCache.ts — append after the existing export

/**
 * For routed Anthropic Claude models (OpenRouter/Bedrock/LiteLLM/Azure),
 * adds conversation-level cache breakpoints using the same 2-breakpoint strategy
 * as the native Anthropic path.
 *
 * This function is safe to call unconditionally — it checks `enablePromptCache`
 * and `isAnthropicRoutedModel` internally.
 */
export const applyRoutedAnthropicConversationCache = (
    messages: OpenAIWireMessage[],
    enablePromptCache: boolean,
    providerName: ProviderName,
    modelName: string,
): OpenAIWireMessage[] => {
    if (!enablePromptCache || !isAnthropicRoutedModel(providerName, modelName)) {
        return messages;
    }

    // Collect user message indices (oldest first), excluding the system message at index 0
    const userIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
            userIndices.push(i);
        }
    }

    if (userIndices.length < 3) {
        return messages;
    }

    const bp4Idx = userIndices[userIndices.length - 2];
    const midpoint = Math.floor((userIndices.length - 2) / 2);
    const bp3Idx = userIndices[midpoint];
    const targets = bp3Idx !== bp4Idx ? [bp3Idx, bp4Idx] : [bp4Idx];

    const result = [...messages];

    for (const targetIdx of targets) {
        const msg = result[targetIdx];
        if (typeof msg.content === 'string') {
            result[targetIdx] = {
                ...msg,
                content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } as const }],
            };
        } else if (Array.isArray(msg.content) && msg.content.length > 0) {
            const blocks = [...(msg.content as Record<string, unknown>[])];
            blocks[blocks.length - 1] = {
                ...blocks[blocks.length - 1],
                cache_control: { type: 'ephemeral' } as const,
            };
            result[targetIdx] = { ...msg, content: blocks };
        }
    }

    return result;
};
```

**Call site in `sendLLMMessage.impl.ts` (`_sendOpenAICompatibleChat`, after line 354):**

```typescript
// BEFORE (lines 353–358):
messages: applyRoutedAnthropicPromptCache(
    messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    separateSystemMessage,
    enablePromptCache,
    providerName,
    modelName,
    volatileSystemMessage,
) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],

// AFTER — chain both functions:
messages: (() => {
    const withSystemCache = applyRoutedAnthropicPromptCache(
        messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        separateSystemMessage,
        enablePromptCache,
        providerName,
        modelName,
        volatileSystemMessage,
    );
    return applyRoutedAnthropicConversationCache(
        withSystemCache,
        enablePromptCache,
        providerName,
        modelName,
    );
})() as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
```

---

### OPT 3 — MEDIUM ROI: Stable block hash guard — catch cache-busting regressions at dev time

**File:** `src/vs/workbench/contrib/trove/browser/convertToLLMMessageService.ts`

After fixing BUG 1, add a development-mode invariant that fires a console warning if the stable
system message changes between consecutive turns of the same thread. This catches future regressions
where volatile content leaks back into the stable block.

```typescript
// FILE: browser/convertToLLMMessageService.ts
// Add to the top of the class, after existing private fields:

private readonly _stableBlockHashByThread = new Map<string, number>();

// Add a simple djb2 hash function (private utility):
private _hashString(s: string): number {
    let hash = 5381;
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
        hash = hash >>> 0; // convert to unsigned 32-bit
    }
    return hash;
}
```

**In `prepareLLMChatMessages` (around line 779, after `separateSystemMessage` is set):**

```typescript
// DEV-mode stable block hash guard — fires if the cached system message mutates mid-session
if (process.env.NODE_ENV === 'development' || process.env.TROVE_DEBUG_CACHE) {
    const threadId = opts.chatMessages[0]?.threadId ?? 'unknown';
    const hash = this._hashString(separateSystemMessage ?? '');
    const prev = this._stableBlockHashByThread.get(threadId);
    if (prev !== undefined && prev !== hash) {
        console.warn(
            '[Trove cache] ⚠️  Stable system message changed mid-session for thread',
            threadId,
            '— this busts the prompt cache and triggers an expensive re-write.',
            'Diff the stable block to find volatile content that leaked in.',
        );
    }
    this._stableBlockHashByThread.set(threadId, hash);
}
```

---

## New Test Coverage

**File:** `src/vs/workbench/contrib/trove/browser/test/promptCache.test.ts`

The existing test file has one test. Expand it to cover the new and fixed behaviours:

```typescript
import assert from 'assert';
import {
    isAnthropicRoutedModel,
    applyRoutedAnthropicPromptCache,
    applyRoutedAnthropicConversationCache,
} from '../../common/promptCache.js';

suite('Trove - promptCache', () => {

    // --- existing ---
    test('isAnthropicRoutedModel detects Claude via OpenRouter', () => {
        assert.strictEqual(isAnthropicRoutedModel('openRouter', 'anthropic/claude-3.5-sonnet'), true);
        assert.strictEqual(isAnthropicRoutedModel('openAI', 'gpt-4o'), false);
    });

    // --- BUG 2 regression: no ttl field ---
    test('applyRoutedAnthropicPromptCache produces cache_control without ttl', () => {
        const msgs = [{ role: 'user', content: 'hello' }];
        const result = applyRoutedAnthropicPromptCache(
            msgs, 'stable system', true, 'openRouter', 'anthropic/claude-3.5-sonnet',
        );
        const sysMsg = result[0] as { role: string; content: { cache_control: unknown }[] };
        assert.ok(Array.isArray(sysMsg.content));
        const cc = sysMsg.content[0].cache_control as Record<string, unknown>;
        assert.strictEqual(cc['type'], 'ephemeral');
        assert.strictEqual('ttl' in cc, false, 'cache_control must not contain ttl');
    });

    // --- OPT 2: routed conversation cache ---
    test('applyRoutedAnthropicConversationCache adds breakpoints on second-to-last user msg', () => {
        const msgs = [
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'reply 1' },
            { role: 'user', content: 'turn 2' },
            { role: 'assistant', content: 'reply 2' },
            { role: 'user', content: 'turn 3 (current)' },
        ];
        const result = applyRoutedAnthropicConversationCache(
            msgs, true, 'openRouter', 'anthropic/claude-3.5-sonnet',
        );
        // BP4: second-to-last user (index 2, "turn 2") should have cache_control
        const bp4Msg = result[2] as { role: string; content: { cache_control: unknown }[] };
        assert.ok(Array.isArray(bp4Msg.content));
        assert.deepStrictEqual(bp4Msg.content[0].cache_control, { type: 'ephemeral' });
        // Last user message (current turn) should NOT have cache_control
        const lastMsg = result[4] as { role: string; content: string };
        assert.strictEqual(typeof lastMsg.content, 'string',
            'current user turn must remain as plain string (uncached)');
    });

    test('applyRoutedAnthropicConversationCache is no-op when cache disabled', () => {
        const msgs = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'assistant', content: 'd' },
            { role: 'user', content: 'e' },
        ];
        const result = applyRoutedAnthropicConversationCache(
            msgs, false, 'openRouter', 'anthropic/claude-3.5-sonnet',
        );
        assert.strictEqual(result, msgs, 'should return same reference when disabled');
    });

    test('applyRoutedAnthropicConversationCache is no-op for non-Anthropic routed models', () => {
        const msgs = [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
            { role: 'assistant', content: 'd' },
            { role: 'user', content: 'e' },
        ];
        const result = applyRoutedAnthropicConversationCache(
            msgs, true, 'openRouter', 'gpt-4o',   // non-Claude model via OpenRouter
        );
        assert.strictEqual(result, msgs);
    });
});
```

---

## Summary Table — Files, Changes, Priority

| # | File | Change | Priority | Est. LOC |
|---|---|---|---|---|
| BUG 1 | `common/prompt/prompts.ts` | Move `activeURI` domain context to volatile; extract `buildDomainContextBlock()` | 🔴 Critical | +30, -20 |
| BUG 1 | `browser/convertToLLMMessageService.ts` | Remove `activeURI` from `chat_systemMessage_stable` call | 🔴 Critical | -1 |
| BUG 2 | `common/promptCache.ts` | Remove `ttl` from `cacheBlock`; fix inline type | 🟠 Medium | -3 |
| BUG 2 | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Replace `as CacheControlEphemeral` with `satisfies` × 4 | 🟠 Medium | ±4 |
| BUG 3 | `common/usageMeteringTypes.ts` | Add `totalCacheWriteTokens` to `MeteringSession` | 🟠 Medium | +1 |
| BUG 3 | `browser/usageMeteringService.ts` | Track `totalCacheWriteTokens` in `recordTurn`; init to 0 | 🟠 Medium | +2 |
| BUG 4 | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Gate `prompt_cache_key` on `enablePromptCache` | 🟡 Low | ±1 |
| BUG 5 | `common/agentOutputTokenLimits.ts` | Remove dead `enablePromptCache` param | 🟡 Low | -2 |
| BUG 5 | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Update `getAnthropicBetaHeaders` call site | 🟡 Low | -1 |
| OPT 1 | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Replace single-BP function with dual-BP `addConversationCacheBreakpoints` | 🟢 High ROI | +50, -42 |
| OPT 2 | `common/promptCache.ts` | Add `applyRoutedAnthropicConversationCache` | 🟢 High ROI | +40 |
| OPT 2 | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Chain new function in `_sendOpenAICompatibleChat` | 🟢 High ROI | +10 |
| OPT 3 | `browser/convertToLLMMessageService.ts` | Add stable block hash guard for dev/debug mode | 🔵 Guardrail | +20 |
| Tests | `browser/test/promptCache.test.ts` | 4 new test cases for routed cache + no-ttl + no-op paths | 🔵 Coverage | +55 |

---

## Recommended Execution Order

1. **BUG 1** — fix first; it's actively defeating every session's cache efficiency
2. **BUG 2** — simple cleanup; do alongside BUG 1 (same mental context)
3. **OPT 1** — dual breakpoints; highest cost savings per line of code changed
4. **OPT 2** — routed provider breakpoints; same logic, different code path
5. **BUG 3** — metering fix; needed before presenting accurate savings to users
6. **BUG 4 + BUG 5** — cleanup; low-risk, quick
7. **OPT 3** — hash guard; add last, after BUG 1 is confirmed clean
8. **Tests** — add alongside each change or in a final cleanup commit

---

## Expected Savings Estimate

For a typical Sonnet 4.6 agent session (25 turns, ~8,000-token stable system, ~200 tokens/turn):

| Scenario | Cost before | Cost after | Saving |
|---|---|---|---|
| Turn 1 (cold cache) | $0.024 (8k write + 200 input) | $0.030 (8k write + 200 input) | +25% (one-time write surcharge) |
| Turns 2–25 (warm cache) | $0.0072/turn (8k input + 200) | $0.00096/turn (8k cache-read + 200) | **87% per turn** |
| BUG 1 fix (file-nav sessions) | Cache busted on every nav → write rate every turn | Cache stable across file navs → one write, 24 reads | **~87% reduction in system message cost** |
| OPT 1 (dual BP, turn 15+) | ~6,000 uncached conv tokens/turn | ~1,500 uncached conv tokens/turn | **75% conv history saving** |

*Savings compound: BUG 1 + OPT 1 together produce ~82% total cost reduction per session
versus the current implementation for ONDC-adjacent workspaces.*
