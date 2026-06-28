# LiteLLM + AWS Bedrock → Trove: Complete Bridge Guide
> Addresses all 6 gaps. Two-part fix: litellm_config.yaml (proxy side) + 4 code
> edits in Trove (same edits from the previous plan, adjusted for Bedrock).

---

## Architecture

```
Trove (LiteLLM provider)
  │  provider: liteLLM
  │  endpoint: http://localhost:4000
  │  model:    claude-sonnet-4-6
  │
  ▼  HTTP POST /chat/completions (OpenAI wire format)
  │  Body includes:
  │    thinking: { type:'enabled', budget_tokens: 10000 }  ← Gap 1 fix
  │    messages with cache_control blocks                   ← Gap 4
  │
LiteLLM proxy (localhost:4000)
  │  Looks up model_name: 'claude-sonnet-4-6'
  │  → maps to: bedrock/us.anthropic.claude-sonnet-4-5-...-v1:0
  │  Translates: OpenAI format → AWS Bedrock Converse API format
  │  Signs request with AWS SigV4 (using access key + secret)
  │  Forwards: thinking param, cache_control blocks natively
  │
  ▼  AWS Bedrock Converse API (HTTPS + SigV4)
  │  No anthropic-beta header needed — Bedrock handles natively
  │
AWS Bedrock → Claude
  │  Extended thinking: ✓ via inferenceConfig
  │  Prompt caching:    ✓ via cache_control blocks in request body
  │  Native tools:      ✓ via Bedrock tool_use format
  │
  ▼  Streaming response
  │  reasoning_content delta → fullReasoning in Trove
  │  synthetic anthropicReasoning built → LiveReasoningBlock renders
```

---

## Step 1 — Environment variables (set before starting LiteLLM)

**Option A — Shell exports (quick dev setup):**
```bash
export AWS_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
export AWS_DEFAULT_REGION="us-east-1"

litellm --config litellm_config.yaml --port 4000
```

**Option B — `.env` file (recommended for persistent setup):**

Create `.env` in the same directory as `litellm_config.yaml`:
```dotenv
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_DEFAULT_REGION=us-east-1
```

Start with:
```bash
litellm --config litellm_config.yaml --port 4000 --env-file .env
```

**Option C — `pm2` for always-on background process:**
```bash
pm2 start "litellm --config litellm_config.yaml --port 4000 --env-file .env" \
  --name litellm-trove \
  --time

pm2 save   # persist across reboots
```

---

## Step 2 — Trove LiteLLM provider configuration

In Trove → Settings → LiteLLM:

| Field | Value | Notes |
|---|---|---|
| **Endpoint** | `http://localhost:4000` | No trailing `/v1` — Trove adds it internally |
| **API Key** | *(leave blank)* | No key needed; Bedrock auth is inside LiteLLM |
| **Model (Chat)** | `claude-sonnet-4-6` | Must match `model_name` in litellm_config.yaml exactly |
| **Model (Ctrl+K)** | `claude-sonnet-4-6` | Same model for all features |
| **Model (Autocomplete)** | `claude-haiku-4-5` | Haiku for fast FIM completions |

After Gap 3 code fix is applied:
- The **thinking budget slider** appears in the model options panel for Claude models
- Context window shows **200k** (was incorrectly 4096 before fix)
- Tool calling uses **native format** (was XML fallback before fix)

---

## Step 3 — Bedrock model ID reference

The `model_name` in Trove must exactly match `model_name` in `litellm_config.yaml`.
The actual Bedrock model ID goes in `litellm_params.model`.

| Trove model name | Bedrock model ID | Thinking | Notes |
|---|---|---|---|
| `claude-sonnet-4-6` | `bedrock/us.anthropic.claude-sonnet-4-5-20251119-v1:0` | ✓ | Primary thinking model |
| `claude-opus-4-6` | `bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0` | ✓ | Highest quality |
| `claude-haiku-4-5` | `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` | Limited | Fast, cheap |
| `claude-3-7-sonnet-20250219` | `bedrock/us.anthropic.claude-3-7-sonnet-20250219-v1:0` | ✓ | Known stable |
| `claude-3-5-sonnet-20241022` | `bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0` | ✗ | Stable baseline |
| `claude-3-5-haiku-20241022` | `bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0` | ✗ | Fastest |

**Finding exact Bedrock IDs for your region:**
```bash
aws bedrock list-foundation-models \
  --region us-east-1 \
  --query 'modelSummaries[?contains(modelId,`anthropic`)].[modelId,modelName]' \
  --output table
```

**Cross-region inference** (us.* prefix): higher quota, lower latency, availability across
us-east-1, us-west-2, us-gov-west-1. Use this unless you have a compliance reason to pin
to one region.

---

## Step 4 — Code fixes (4 edits, same as previous plan adjusted for Bedrock)

### Fix 4-A: `common/modelCapabilities.ts` — Recognize Claude via LiteLLM

**What changes:** `liteLLMSettings.modelOptionsFallback` delegates Claude model names to
Anthropic's fallback logic, giving the correct context window, `specialToolFormat`, and
reasoning capabilities. This fixes Gaps 3, 4 (tool format), and 6 (sandbox) simultaneously.

**Where:** `common/modelCapabilities.ts`, inside the `liteLLMSettings` const.
Must be placed AFTER `const anthropicSettings` in the file.

```typescript
const liteLLMSettings: VoidStaticProviderInfo = {
  modelOptionsFallback: (modelName) => {
    const lower = modelName.toLowerCase()
    // Strip optional "anthropic/" prefix users sometimes type (e.g. "anthropic/claude-sonnet-4-6")
    const cleanName = lower.replace(/^anthropic\//, '')

    // Delegate Claude models to Anthropic's own fallback so we get:
    //   - correct context window (200k)
    //   - specialToolFormat: 'openai-style' (LiteLLM auto-converts to Anthropic/Bedrock format)
    //   - reasoningCapabilities with budget_slider (thinking UI shows up)
    //   - correct supportsSystemMessage value
    if (cleanName.includes('claude')) {
      const anthropicResult = anthropicSettings.modelOptionsFallback?.(cleanName)
      if (anthropicResult) {
        return {
          ...anthropicResult,
          modelName: modelName,               // preserve original name (not Anthropic's canonical)
          // openai-style: LiteLLM handles format translation to Anthropic/Bedrock internally
          specialToolFormat: 'openai-style',
        }
      }
    }

    // Non-Claude model: generic fallback
    return extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } })
  },
  providerReasoningIOSettings: {
    input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
    output: { nameOfFieldInDelta: 'reasoning_content' },  // LiteLLM surfaces Bedrock thinking here
  },
}
```

---

### Fix 4-B: `common/modelCapabilities.ts` — Send thinking budget to LiteLLM+Bedrock

**What changes:** `openAICompatIncludeInPayloadReasoning` currently only handles
`effort_slider_value` (OpenAI). Adding `budget_slider_value` makes the thinking parameter
reach LiteLLM, which then translates it to Bedrock's `inferenceConfig.reasoningConfig`.

```typescript
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
  if (!reasoningInfo?.isReasoningEnabled) return null

  if (reasoningInfo.type === 'effort_slider_value') {
    return { reasoning_effort: reasoningInfo.reasoningEffort }
  }

  // NEW — for Claude models via LiteLLM → Bedrock:
  // LiteLLM translates { thinking: ... } to Bedrock's inferenceConfig.reasoningConfig
  // https://docs.litellm.ai/docs/providers/bedrock#extended-thinking
  if (reasoningInfo.type === 'budget_slider_value') {
    return { thinking: { type: 'enabled', budget_tokens: reasoningInfo.reasoningBudget } }
  }

  return null
}
```

**Note:** This function is shared by ALL OpenAI-compatible providers (LiteLLM, OpenRouter,
Azure, vLLM, etc.). The `thinking` parameter is safe to send — providers that don't
understand it will either ignore it or LiteLLM's `drop_params: true` will strip it.

---

### Fix 4-C: `electron-main/llmMessage/sendLLMMessage.impl.ts` — Synthesize anthropicReasoning

**What changes:** The OpenAI-compatible path always sets `anthropicReasoning: null`.
After this fix, when LiteLLM returns reasoning via `reasoning_content`, we synthesize a
minimal `anthropicReasoning` block so `LiveReasoningBlock` renders with the timer display.

**Where:** `_sendOpenAICompatibleChat` function, immediately before the `onFinalMessage` call.

Find the anchor (line ~441):
```typescript
// FIND THIS:
onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, usage: latestUsage, ...toolCallObj });
```

**Replace with:**
```typescript
// Synthesize anthropicReasoning so LiveReasoningBlock timer/collapse renders correctly.
// This applies when LiteLLM routes a Claude model through Bedrock or direct Anthropic
// and surfaces reasoning via the 'reasoning_content' delta field.
// LIMITATION: signature is '' — multi-turn extended thinking continuity requires
// the real signature, which is only available via the native Anthropic SDK path.
const isLiteLLMClaudeModel = providerName === 'liteLLM'
  && modelName.toLowerCase().includes('claude')

const syntheticAnthropicReasoning: AnthropicReasoning[] | null =
  (isLiteLLMClaudeModel && fullReasoningSoFar)
    ? [{ type: 'thinking' as const, thinking: fullReasoningSoFar, signature: '' }]
    : null

onFinalMessage({
  fullText: fullTextSoFar,
  fullReasoning: fullReasoningSoFar,
  anthropicReasoning: syntheticAnthropicReasoning,
  usage: latestUsage,
  ...toolCallObj,
});
```

**Import check:** `AnthropicReasoning` is already imported at the top of the file via
`sendLLMMessageTypes.ts`. No new imports needed.

---

### Fix 4-D: `browser/agentPlan.ts` — Reduce thinking budget for plan sub-calls

**Why:** After Fix 4-B activates thinking, the plan sub-call (300-token output cap) would
spend the full thinking budget (e.g., 10,000 tokens) reasoning about a short plan — slow
and wasteful. Cap thinking tokens for planning at 2,048.

**Where:** `generateAgentPlan()` function.

```typescript
// FIND the sendLLMMessage call in generateAgentPlan():
const requestId = llmMessageService.sendLLMMessage({
  messages: planMessages,
  featureName,
  modelSelectionOptions,
  // ...existing params...
})

// REPLACE WITH:
// Reduce thinking budget for planning sub-calls. The plan output is only
// 300 tokens — deep thinking isn't needed. This prevents a 10k thinking
// token spend for a 300-token plan when using Claude via LiteLLM.
const planModelOptions: ModelSelectionOptions = {
  ...modelSelectionOptions,
  reasoningBudget: modelSelectionOptions?.reasoningBudget
    ? Math.min(modelSelectionOptions.reasoningBudget, 2048)
    : modelSelectionOptions?.reasoningBudget,
}

const requestId = llmMessageService.sendLLMMessage({
  messages: planMessages,
  featureName,
  modelSelectionOptions: planModelOptions,
  // ...existing params...
})
```

---

## Step 5 — Why prompt caching works without code changes for Bedrock

**Direct Anthropic path (native SDK):**
- Caching activated by `betas: ['prompt-caching-2024-07-31']` in the SDK call
- `cache_control` blocks in messages signal breakpoints

**LiteLLM → Bedrock path:**
- `applyRoutedAnthropicPromptCache()` already injects `cache_control` blocks (this runs for ALL providers including `liteLLM`)
- LiteLLM translates `cache_control` blocks to Bedrock's prompt caching format automatically
- No `anthropic-beta` header needed — Bedrock prompt caching is always available, no opt-in beta
- `drop_params: true` in `litellm_config.yaml` handles any unsupported parameter gracefully

**Result:** No additional code change needed for caching. It works via:
1. `applyRoutedAnthropicPromptCache()` (already running) → injects `cache_control`
2. LiteLLM → translates to Bedrock format
3. Bedrock → caches at breakpoints → returns `cacheReadTokens > 0` from turn 2

**Verify caching is working:**
After a 2-turn session in Trove, check UsageDashboard:
- Turn 1: `cacheWriteTokens > 0`, `cacheReadTokens = 0`
- Turn 2: `cacheReadTokens > 0` (should be ~7,000–8,000 for the system message)

---

## Step 6 — Complete edit order

```
Config side (no rebuild needed):
  1. Create .env with AWS credentials
  2. Update litellm_config.yaml with your Bedrock model IDs
     (check: aws bedrock list-foundation-models --region us-east-1)
  3. Start LiteLLM: litellm --config litellm_config.yaml --port 4000 --env-file .env
  4. Verify: curl http://localhost:4000/health/liveliness → { "status": "healthy" }
  5. Test model: curl http://localhost:4000/v1/models → should list claude-sonnet-4-6

Code side (rebuild needed):
  6. common/modelCapabilities.ts — Fix 4-A (liteLLMSettings.modelOptionsFallback)
  7. common/modelCapabilities.ts — Fix 4-B (openAICompatIncludeInPayloadReasoning)
     Both are in the same file — do in one edit session.
  8. electron-main/llmMessage/sendLLMMessage.impl.ts — Fix 4-C (synthetic anthropicReasoning)
  9. browser/agentPlan.ts — Fix 4-D (planning budget cap)
 10. Rebuild Trove (pnpm build or your build command)

Trove configuration:
 11. Settings → LiteLLM → Endpoint: http://localhost:4000
 12. Settings → LiteLLM → Model: claude-sonnet-4-6
 13. Toggle thinking budget slider (visible after Fix 4-A)
 14. Set budget to 8,000–12,000 tokens for agent mode tasks

Verification:
 15. Open a file in STaaS workspace
 16. Ask agent to analyse it — confirm LiveReasoningBlock shows "Thinking…"
 17. Check UsageDashboard turn 2 for cacheReadTokens > 0
 18. Ask a tool-heavy task — confirm tool calls use JSON format (not XML)
 19. Check agent plan renders 3–7 bullets within ~3 seconds (not 10+ seconds with
     full 10k budget on the plan sub-call)
```

---

## Step 7 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `thinking` block never shows | LiteLLM not forwarding `thinking` param | Check `drop_params: true` in config; verify LiteLLM ≥ 1.40 |
| `NoCredentialsError` in LiteLLM logs | AWS env vars not set | `echo $AWS_ACCESS_KEY_ID` — must be non-empty |
| Model not found 404 | Bedrock model ID wrong or not enabled | Run `aws bedrock list-foundation-models` to confirm |
| Tool calls arrive as XML | Gap 3 code fix not applied | Apply Fix 4-A; rebuild Trove |
| Thinking slider not visible in UI | Gap 3 code fix not applied | Apply Fix 4-A; rebuild Trove |
| `cacheReadTokens` always 0 | LiteLLM not forwarding cache_control | Update LiteLLM to ≥ 1.40; `drop_params: true` must be set |
| Plan takes > 30 seconds | Full thinking budget on plan sub-call | Apply Fix 4-D |
| Bedrock Throttling / 429 | Bedrock quota exceeded | Increase service quota in AWS Console |
| Timeout on long edits | `request_timeout` too low | Set to 660+ in litellm_config.yaml |
