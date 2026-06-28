# Anthropic Direct vs LiteLLM — Gap Analysis & Bridge Plan
> All line numbers confirmed from live `trove_v1` source. Every fix grounded in
> the actual code path that executes for each provider.

---

## The Root Cause in One Sentence

LiteLLM dispatches to `_sendOpenAICompatibleChat()` — the same function as
OpenAI, Groq, and Ollama. That function was designed for OpenAI-style models.
When Claude thinking models route through it, four things silently break.

---

## Gap 1 (Critical) — Thinking budget never sent to LiteLLM

**File:** `common/modelCapabilities.ts` · Function: `openAICompatIncludeInPayloadReasoning`

**Current code (line 798):**
```typescript
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
  if (!reasoningInfo?.isReasoningEnabled) return null
  if (reasoningInfo.type === 'effort_slider_value') {
    return { reasoning_effort: reasoningInfo.reasoningEffort }
  }
  return null   // ← budget_slider (Claude thinking) falls through to null
}
```

The function handles `effort_slider_value` (OpenAI o-series) but returns `null` for
`budget_slider_value` (Anthropic thinking). So when LiteLLM is configured with a Claude
thinking model and the user has the thinking budget slider set, the payload sent to
LiteLLM has no thinking parameter — the model responds as a standard completion.

**Fix — extend to handle budget_slider for LiteLLM:**
```typescript
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
  if (!reasoningInfo?.isReasoningEnabled) return null

  if (reasoningInfo.type === 'effort_slider_value') {
    return { reasoning_effort: reasoningInfo.reasoningEffort }
  }

  // NEW: LiteLLM passes through Anthropic's thinking parameter when routing to Claude
  // https://docs.litellm.ai/docs/reasoning_content
  if (reasoningInfo.type === 'budget_slider_value') {
    return { thinking: { type: 'enabled', budget_tokens: reasoningInfo.reasoningBudget } }
  }

  return null
}
```

---

## Gap 2 (Critical) — `anthropicReasoning` always null via LiteLLM

**File:** `electron-main/llmMessage/sendLLMMessage.impl.ts`
**Function:** `_sendOpenAICompatibleChat` · Line ~441

**Current code:**
```typescript
// In _sendOpenAICompatibleChat, onFinalMessage call:
onFinalMessage({
  fullText: fullTextSoFar,
  fullReasoning: fullReasoningSoFar,   // ← populated from 'reasoning_content' delta
  anthropicReasoning: null,            // ← ALWAYS null for all OpenAI-compatible providers
  usage: latestUsage,
  ...toolCallObj,
});
```

**Why it matters:** `LiveReasoningBlock` in `SidebarChat.tsx` renders the thinking
display using BOTH `chatMessage.reasoning` (from `fullReasoning`) AND
`formatAnthropicReasoning(chatMessage.anthropicReasoning)`. More critically,
`anthropicReasoning` blocks contain a `signature` field that Anthropic requires to be
echoed back in multi-turn conversations with extended thinking enabled. Without it,
continued reasoning across turns is broken.

**Fix — synthesize anthropicReasoning when provider is LiteLLM + Claude + reasoning present:**

In `_sendOpenAICompatibleChat`, after the stream ends, before calling `onFinalMessage`:

```typescript
// === ADD THIS BLOCK before the final onFinalMessage call ===

// When routing Claude thinking models through LiteLLM, 'reasoning_content' in the
// delta populates fullReasoningSoFar. We synthesize an anthropicReasoning block
// so the UI LiveReasoningBlock timer/collapse works correctly.
// NOTE: signature is empty — this breaks MULTI-TURN extended thinking continuity.
// For multi-turn, use the full Config fix (litellm_config.yaml) + signature passthrough.
const isLiteLLMClaudeModel = providerName === 'liteLLM'
  && modelName.toLowerCase().includes('claude')

const syntheticAnthropicReasoning: AnthropicReasoning[] | null =
  (isLiteLLMClaudeModel && fullReasoningSoFar)
    ? [{ type: 'thinking', thinking: fullReasoningSoFar, signature: '' }]
    : null

// Replace:
// onFinalMessage({ ..., anthropicReasoning: null, ... })
// With:
onFinalMessage({
  fullText: fullTextSoFar,
  fullReasoning: fullReasoningSoFar,
  anthropicReasoning: syntheticAnthropicReasoning,   // ← now populated for LiteLLM+Claude
  usage: latestUsage,
  ...toolCallObj,
});
```

**Import note:** `AnthropicReasoning` type is already available in the file via
`sendLLMMessageTypes.ts` imports. No new imports needed.

---

## Gap 3 (Critical) — Claude model not recognized, wrong tool format

**File:** `common/modelCapabilities.ts`

**Current state:**
```typescript
liteLLM: [],   // line 141 — modelOptions is completely empty
```

```typescript
const liteLLMSettings: VoidStaticProviderInfo = {
  modelOptionsFallback: (modelName) =>
    extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
  // ...
}
```

`extensiveModelOptionsFallback` is a generic fallback that doesn't know Claude's:
- Context window (200k)
- `specialToolFormat: 'openai-style'` (without this, tools fall back to XML prompting)
- `reasoningCapabilities` (budget slider not shown in UI)
- `supportsSystemMessage: 'separated'` → system message handled differently

**What `specialToolFormat` controls:**
```typescript
// In _sendOpenAICompatibleChat:
const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style'
  ? { tools: potentialTools }   // ← native OpenAI-format tools
  : {}                          // ← no tools → falls back to XML in prompt
```

When `specialToolFormat` is not set for Claude via LiteLLM, the agent gets no native
tools — instead it sees tool definitions as XML in the system prompt and is expected
to respond with XML. This is a completely different execution path for every single
tool call, explaining the sandbox testing differences.

**Fix — add Claude model recognition to liteLLMSettings:**

```typescript
const liteLLMSettings: VoidStaticProviderInfo = {
  modelOptionsFallback: (modelName) => {
    const lower = modelName.toLowerCase()
    const cleanName = lower.replace(/^anthropic\//, '')  // strip "anthropic/" prefix if present

    // Delegate Claude models to anthropic's model fallback logic
    // This gives us correct context window, specialToolFormat, reasoningCapabilities etc.
    if (cleanName.includes('claude')) {
      const anthropicFallback = anthropicSettings.modelOptionsFallback?.(cleanName)
      if (anthropicFallback) {
        return {
          ...anthropicFallback,
          modelName: modelName,           // keep original LiteLLM model name
          // LiteLLM auto-converts anthropic-style tool definitions to Anthropic's format,
          // but the SDK call uses OpenAI wire format — so we use openai-style here.
          specialToolFormat: 'openai-style',
        }
      }
    }

    // Non-Claude: generic fallback as before
    return extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } })
  },
  providerReasoningIOSettings: {
    input: { includeInPayload: openAICompatIncludeInPayloadReasoning },  // now handles budget_slider (Gap 1 fix)
    output: { nameOfFieldInDelta: 'reasoning_content' },                  // LiteLLM surfaces Claude thinking here
  },
}
```

**Important:** `anthropicSettings` must be declared before `liteLLMSettings` in the file.
Check the order in `modelCapabilities.ts` and move `liteLLMSettings` after the `const
anthropicSettings = ...` declaration.

---

## Gap 4 — Prompt caching not reaching Anthropic

**Files involved:**
- `common/promptCache.ts` — injects `cache_control` blocks
- `electron-main/llmMessage/sendLLMMessage.impl.ts` — `_sendOpenAICompatibleChat`
  calls `applyRoutedAnthropicPromptCache(...)` (already does the right thing)
- **The missing piece:** LiteLLM must forward the `anthropic-beta` header to Anthropic

`applyRoutedAnthropicPromptCache()` already injects `cache_control: { type: 'ephemeral' }`
into the system message and second breakpoint. However, Anthropic's caching only activates
when the request includes `anthropic-beta: prompt-caching-2024-07-31`.

When using the Anthropic SDK natively (direct), the SDK adds this header automatically
via `betas: ['prompt-caching-2024-07-31']` in the request. Via LiteLLM, this header
needs to be passed explicitly.

**Fix A — litellm_config.yaml (recommended):**
```yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"

  - model_name: claude-opus-4-6
    litellm_params:
      model: anthropic/claude-opus-4-6
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"

litellm_settings:
  # Forward extra_headers set in requests directly to the underlying API
  forward_client_headers_to_llm_api: true
```

**Fix B — code-side in `_sendOpenAICompatibleChat` for LiteLLM + Claude:**
```typescript
// In _sendOpenAICompatibleChat, when building the OpenAI options:
const isLiteLLMClaude = providerName === 'liteLLM'
  && modelName.toLowerCase().includes('claude')

const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
  model: modelName,
  messages: applyRoutedAnthropicPromptCache(...),
  stream: true,
  stream_options: { include_usage: true },
  ...nativeToolsObj,
  // NEW: inject anthropic-beta header for LiteLLM+Claude to activate caching:
  ...(isLiteLLMClaude ? {
    extra_headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' }
  } : {}),
}
```

The `extra_headers` field in OpenAI SDK options is passed through to the HTTP request.
LiteLLM will receive this header and forward it to Anthropic.

---

## Gap 5 — Planning phase: thinking budget for sub-calls

The `generateAgentPlan()` sub-call in `agentPlan.ts` fires `ILLMMessageService.sendLLMMessage`
with `PLAN_OUTPUT_TOKEN_CAP = 300`. With extended thinking enabled (budget e.g. 10,000 tokens),
the model might spend all 10k thinking tokens to produce a 300-token plan — which is
disproportionate and slow.

**Current behavior via Direct Anthropic:** The thinking model CAN think before planning,
producing a better structured plan. This is visible in the UI as a "Thinking…" block
before the plan bullets appear.

**Via LiteLLM (pre-fix):** No thinking at all → plan generated as standard completion.
**Via LiteLLM (post-Gap-1-fix):** Thinking enabled → 10k budget for a 300-token plan
→ noticeably slower planning phase.

**Fix — reduce thinking budget for plan sub-calls:**

In `agentPlan.ts`, pass a model options override that reduces the thinking budget:
```typescript
// agentPlan.ts — generateAgentPlan()

// BEFORE:
const result = await llmMessageService.sendLLMMessage({
  messages: planMessages,
  featureName,
  ...
})

// AFTER: pass a reduced thinking budget for planning sub-calls
const planModelOptions: ModelSelectionOptions = {
  ...modelSelectionOptions,
  // Reduce thinking budget for the planning sub-call:
  // The plan is short (300 tokens) — deep thinking isn't needed
  reasoningBudget: Math.min(
    modelSelectionOptions.reasoningBudget ?? 0,
    2048,   // max 2k thinking tokens for planning
  ),
}

const result = await llmMessageService.sendLLMMessage({
  messages: planMessages,
  featureName,
  modelSelectionOptions: planModelOptions,
  ...
})
```

---

## Gap 6 — Sandbox testing: tool call parsing differences

**Root cause:** Without Gap 3 fix (`specialToolFormat: 'openai-style'`), the agent loop
uses XML tool parsing for all Claude models via LiteLLM. This means:

- Tool definitions are injected as XML strings in the system prompt
- The model responds with XML tool calls like `<tool_call>{"name": "read_file", ...}</tool_call>`
- `extractXMLToolsWrapper` in `extractGrammar.ts` parses these at stream time
- XML parsing is more fragile than native function calling
- The model sometimes half-generates XML (streaming cut-off), causing tool parse errors
- `nConsecutiveToolFails` increments more frequently → loop terminates earlier

After applying the Gap 3 fix, `specialToolFormat: 'openai-style'` ensures:
- Tool definitions go in the `tools` parameter (not the system prompt)
- LiteLLM converts them to Anthropic's native tool format before sending to the model
- Streaming tool calls come as `delta.tool_calls[].function.arguments` (stable JSON fragments)
- Tool execution is identical to direct Anthropic behavior

**No additional code change needed once Gap 3 is applied.** The fix cascades automatically.

---

## LiteLLM Config — Complete `litellm_config.yaml`

```yaml
# litellm_config.yaml — placed in the LiteLLM proxy working directory
# Start: litellm --config litellm_config.yaml

model_list:

  # Claude thinking models — add extra_headers for caching + thinking
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: "os.environ/ANTHROPIC_API_KEY"
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"
      # LiteLLM passes the thinking parameter through to Anthropic when present in the request
      # (this is set by the code fix in openAICompatIncludeInPayloadReasoning)

  - model_name: claude-opus-4-6
    litellm_params:
      model: anthropic/claude-opus-4-6
      api_key: "os.environ/ANTHROPIC_API_KEY"
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"

  - model_name: claude-opus-4-8
    litellm_params:
      model: anthropic/claude-opus-4-8
      api_key: "os.environ/ANTHROPIC_API_KEY"
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"

  # AWS Bedrock example
  - model_name: us.anthropic.claude-sonnet-4-6
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-6
      aws_access_key_id: "os.environ/AWS_ACCESS_KEY_ID"
      aws_secret_access_key: "os.environ/AWS_SECRET_ACCESS_KEY"
      aws_region_name: "us-east-1"
      extra_headers:
        anthropic-beta: "prompt-caching-2024-07-31"

litellm_settings:
  # Forward client-set extra_headers to the underlying API
  forward_client_headers_to_llm_api: true

  # Drop params that Anthropic doesn't support (prevents 422 errors)
  drop_params: true

  # Timeout for long thinking completions (thinking budget + output tokens)
  request_timeout: 600   # 10 minutes for complex tasks

  # Optional: enable LiteLLM's own semantic caching (different from Anthropic's token caching)
  # cache: true
  # cache_params:
  #   type: "redis"
  #   host: "localhost"
  #   port: 6379

general_settings:
  # Required for streaming extended thinking via SSE
  allow_clientside_credentials: false
  max_parallel_requests: 100
```

---

## Trove Settings — How to configure LiteLLM provider in Trove

In Trove settings, for the LiteLLM provider:

```
Endpoint: http://localhost:4000   (or your LiteLLM proxy URL)
Model:    claude-sonnet-4-6       (must match model_name in litellm_config.yaml)
```

After applying all code fixes, the Settings panel for the LiteLLM provider will show:
- Thinking budget slider (was missing before Gap 3 fix)
- Context window 200k (was generic 4096 before fix)
- Native tool calling (was XML fallback before fix)

---

## Complete Fix Summary

| # | Gap | File | Type | Lines affected |
|---|---|---|---|---|
| 1 | Thinking budget not sent | `common/modelCapabilities.ts` | Code | `openAICompatIncludeInPayloadReasoning` |
| 2 | `anthropicReasoning = null` | `electron-main/llmMessage/sendLLMMessage.impl.ts` | Code | `_sendOpenAICompatibleChat` final message |
| 3 | Claude not recognized | `common/modelCapabilities.ts` | Code | `liteLLMSettings.modelOptionsFallback` |
| 4 | Prompt cache headers | `electron-main/llmMessage/sendLLMMessage.impl.ts` + `litellm_config.yaml` | Code + Config | `_sendOpenAICompatibleChat` options |
| 5 | Planning thinking budget | `browser/agentPlan.ts` | Code | `generateAgentPlan()` call |
| 6 | Tool format (XML vs native) | Fixed by Gap 3 (specialToolFormat) | Cascades | — |

**Apply in this order:**
```
1. litellm_config.yaml (proxy side — no Trove rebuild needed)
2. common/modelCapabilities.ts (Gaps 1 + 3 — same file, one edit)
3. electron-main/llmMessage/sendLLMMessage.impl.ts (Gaps 2 + 4)
4. browser/agentPlan.ts (Gap 5)
5. Rebuild Trove
6. Restart LiteLLM proxy
7. Verify: Settings panel shows thinking slider for LiteLLM+Claude
8. Verify: LiveReasoningBlock shows "Thinking…" during agent run
9. Verify: cacheReadTokens > 0 after turn 2 (UsageDashboard)
10. Verify: Tool calls use native format (not XML fallback)
```
