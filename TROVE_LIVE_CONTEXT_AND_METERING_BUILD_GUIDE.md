# Trove Feature Build Guide
## Part 1: Live Context Injection  ·  Part 2: Usage Metering in Dollars

**Trove repo:** `github.com/hari8g/trove_v1`
**Base path:** `src/vs/workbench/contrib/trove/`

---

# Part 1 — Live Context Injection

## What This Does & Why

The agent already has a `WorkspaceProfile` fed to it via
`buildRepoContextBlock()` in `prompts.ts`. The current output is thin:

```xml
<repository_context>
Project: trove_v1
Languages: typescript
Frameworks: react
Purpose: unknown            ← null in most fresh workspaces
Architecture: unknown       ← null unless manually set
Build: npm run compile
...
</repository_context>
```

`architectureSummary` and `projectPurpose` default to `null` until
the workspace scanner produces them. That means the agent typically
sees almost nothing useful about the codebase structure on the first
dozen queries — it must re-discover everything with tools.

This guide adds:

1. **`serializeWorkspaceProfileForPrompt()`** — a richer, mode-aware
   serializer that extracts everything useful from `WorkspaceProfile`
   in a compact form (≤ 1 200 tokens in agent mode, ≤ 400 in chat).

2. **Staleness auto-refresh** — if `profile.isStale`, a background
   `refreshProfile()` fires before the next agent run.

3. **Mode-gated depth** — agent mode gets full structural facts + all
   commands; chat mode gets only the minimal facts that help with
   conversational questions (language, framework, test command).

4. **Token budget cap** — the injection never exceeds a configurable
   per-mode ceiling so it cannot crowd out tool results.

---

## Code Paths Touched

```
common/prompt/prompts.ts            ← replace buildRepoContextBlock()
                                      add serializeWorkspaceProfileForPrompt()
browser/convertToLLMMessageService.ts ← add staleness guard in
                                      _generateChatMessagesSystemMessage()
common/repoIntelligenceTypes.ts     ← add REPO_PROFILE_TOKEN_CAPS constant
```

No new files required. No IPC changes. No electron-main changes.

---

## FILE 1 — `common/repoIntelligenceTypes.ts` (MODIFY)

Append after the existing constants:

```typescript
// ── Injection token budget caps (per mode) ────────────────────────────────────
// These prevent the profile block from crowding out tool results in long runs.
// Values are CHAR counts (CHARS_PER_TOKEN = 4), not token counts directly.

export const REPO_PROFILE_MAX_CHARS: Record<'agent' | 'gather' | 'normal', number> = {
  agent:  4_800,   // ~1 200 tokens — agent needs full structural context
  gather: 3_200,   // ~800  tokens — gather needs commands + framework
  normal: 1_600,   // ~400  tokens — chat needs only language + minimal facts
};
```

---

## FILE 2 — `common/prompt/prompts.ts` (MODIFY)

### Step 1 — Replace `buildRepoContextBlock()` with the new serializer

Find and replace the existing `buildRepoContextBlock` function (around line 506)
with the following two functions:

```typescript
// ── Workspace profile serializer ──────────────────────────────────────────────

/**
 * Converts a WorkspaceProfile into a compact, mode-aware XML block that is
 * injected into the system message before every LLM call.
 *
 * Design goals:
 *  - Agent mode: give the agent enough structural context to skip the
 *    "orientation" phase (discover languages, find test command, etc.)
 *  - Chat mode: give just enough for natural language questions without
 *    wasting tokens on data the user didn't ask about.
 *  - Never exceed REPO_PROFILE_MAX_CHARS[mode] characters.
 *  - Never produce stale facts — caller is responsible for refreshing first.
 */
export function serializeWorkspaceProfileForPrompt(
  profile: WorkspaceProfile | null,
  mode: ChatMode,
): string {
  if (!profile) return '';

  const projectName = profile.workspaceRoot.split('/').at(-1) ?? profile.workspaceRoot;
  const staleNote = profile.isStale ? ' [stale — being refreshed in background]' : '';

  // ── Minimal block (all modes) ────────────────────────────────────────────
  const lines: string[] = [
    `Project: ${projectName}${staleNote}`,
    `Languages: ${profile.languageStack.join(', ') || 'unknown'}`,
    `Frameworks: ${profile.frameworks.map(f =>
      f.version ? `${f.name}@${f.version}` : f.name
    ).join(', ') || 'none detected'}`,
    `Package managers: ${profile.packageManagers.join(', ') || 'unknown'}`,
  ];

  if (profile.projectPurpose) {
    lines.push(`Purpose: ${profile.projectPurpose}`);
  }

  // ── Commands (all modes — saves the agent from discovering them) ─────────
  const buildCmd   = profile.buildCommands.find(c => c.purpose === 'build')?.command
                  ?? profile.buildCommands[0]?.command;
  const startCmd   = profile.buildCommands.find(c => c.purpose === 'start')?.command;
  const testCmd    = profile.testCommands[0]?.command;
  const lintCmd    = profile.lintCommands[0]?.command;
  const checkCmd   = profile.typecheckCommands[0]?.command;

  if (buildCmd)  lines.push(`Build command: ${buildCmd}`);
  if (startCmd)  lines.push(`Dev server:    ${startCmd}`);
  if (testCmd)   lines.push(`Test command:  ${testCmd}`);
  if (lintCmd)   lines.push(`Lint command:  ${lintCmd}`);
  if (checkCmd)  lines.push(`Typecheck:     ${checkCmd}`);

  // ── Agent / gather only: richer structural context ───────────────────────
  if (mode === 'agent' || mode === 'gather') {
    lines.push(`File count: ${profile.fileCount.toLocaleString()}`);
    lines.push(`Total LOC:  ${profile.totalLoc.toLocaleString()}`);

    if (profile.architectureSummary) {
      // Wrap long summaries so they don't run into the line budget
      const summary = profile.architectureSummary.length > 400
        ? profile.architectureSummary.slice(0, 400) + '…'
        : profile.architectureSummary;
      lines.push(`Architecture summary: ${summary}`);
    }

    // Secondary commands (useful for multi-purpose repos)
    const allBuild = profile.buildCommands
      .filter(c => c.purpose !== 'build' && c.purpose !== 'start' && c.confidence !== 'low')
      .slice(0, 3);
    if (allBuild.length > 0) {
      lines.push(`Other commands: ${allBuild.map(c => `${c.purpose}: ${c.command}`).join(' · ')}`);
    }
  }

  const body = lines.join('\n');
  const { REPO_PROFILE_MAX_CHARS } = require('../repoIntelligenceTypes.js');
  const cap = REPO_PROFILE_MAX_CHARS[mode] ?? REPO_PROFILE_MAX_CHARS.normal;
  const capped = body.length > cap ? body.slice(0, cap) + '\n…[profile truncated]' : body;

  return `<repository_context>\n${capped}\n</repository_context>`;
}

/**
 * Backward-compatible wrapper — called by chat_systemMessage().
 * Mode defaults to 'agent' to preserve existing behaviour.
 *
 * @deprecated  Call serializeWorkspaceProfileForPrompt(profile, mode) directly.
 */
export function buildRepoContextBlock(
  profile: WorkspaceProfile | null,
  mode: ChatMode = 'agent',
): string {
  return serializeWorkspaceProfileForPrompt(profile, mode);
}
```

### Step 2 — Thread `mode` into `chat_systemMessage()`

The existing call at line 673 already passes `mode` (as `chatMode`).
Update it to pass the mode to the serializer:

```typescript
// Before (line ~673):
const repoContext = buildRepoContextBlock(repoProfile)

// After:
const repoContext = serializeWorkspaceProfileForPrompt(repoProfile, mode)
```

---

## FILE 3 — `browser/convertToLLMMessageService.ts` (MODIFY)

### Add staleness guard to `_generateChatMessagesSystemMessage()`

Find the existing block that fetches the profile (around line 590) and
replace it with the guard version:

```typescript
// ── Before (existing code, ~line 590) ────────────────────────────────────────
let repoProfile = this._repoIntelligenceService.getProfileSync()
if (!repoProfile && workspaceFolders[0]) {
  repoProfile = await this._repoIntelligenceService.getProfile(workspaceFolders[0])
}

// ── After ─────────────────────────────────────────────────────────────────────
let repoProfile = this._repoIntelligenceService.getProfileSync();

if (!repoProfile && workspaceFolders[0]) {
  // First-time load — blocking is acceptable (IPC is fast)
  repoProfile = await this._repoIntelligenceService.getProfile(workspaceFolders[0]);
}

if (repoProfile?.isStale && workspaceFolders[0]) {
  // Stale profile — use the stale data now (to avoid blocking),
  // but kick off a background refresh so the NEXT call is fresh.
  // The serializeWorkspaceProfileForPrompt() adds a [stale] note
  // so the agent knows it may need to verify commands with tools.
  this._repoIntelligenceService
    .refreshProfile(workspaceFolders[0])
    .catch(() => { /* non-fatal */ });
}
```

That is the complete change to `convertToLLMMessageService.ts`. No other
modifications needed — `chat_systemMessage()` already threads `chatMode`
through, and the updated `serializeWorkspaceProfileForPrompt()` uses it.

---

## What the Agent Now Sees (Example)

For a TypeScript/React workspace running Trove itself:

```xml
<repository_context>
Project: trove_v1
Languages: typescript, javascript
Frameworks: react@18.3.1, electron@32.0.0
Package managers: npm
Purpose: Agentic IDE fork of VS Code with multi-provider LLM support
Build command: npm run compile
Dev server: npm run watch
Test command: npm run test
Lint command: npm run eslint
Typecheck: npm run check-types
File count: 8,385
Total LOC: 412,000
Architecture summary: Three-layer architecture — browser/ (VS Code renderer
process, React sidebar, service proxies), electron-main/ (Node.js, LLM calls,
file I/O, SQLite), common/ (types, prompts, pure functions shared across
both layers). IPC channels bridge browser↔main for all side-effectful ops.
Other commands: lint: npm run eslint · format: npm run prettier
</repository_context>
```

**Tokens:** ~310 (agent mode) vs the original ~90. The delta is recovered
on the very first agent turn because the agent no longer needs to call
`get_dir_tree` and `read_file(package.json)` just to learn the framework
and test command.

---

## Mode Comparison Table

| Field injected | agent | gather | chat/normal |
|---|:---:|:---:|:---:|
| Project name | ✅ | ✅ | ✅ |
| Languages | ✅ | ✅ | ✅ |
| Frameworks + versions | ✅ | ✅ | ✅ |
| All commands | ✅ | ✅ | ✅ |
| File count + LOC | ✅ | ✅ | ❌ |
| Architecture summary | ✅ | ✅ | ❌ |
| Secondary commands | ✅ | ❌ | ❌ |
| Staleness note | ✅ | ✅ | ✅ |
| Max chars | 4 800 | 3 200 | 1 600 |

---

## Testing Checklist (Part 1)

- [ ] Agent session on a fresh workspace: agent does NOT call `get_dir_tree`
  just to find the test command (it's already in the system message)
- [ ] `profile.isStale = true` → `[stale]` note appears in the context block
- [ ] Background refresh fires when stale (check `ensureInitialized` was called)
- [ ] Chat mode system message is ≤ 1 600 chars for the profile block
- [ ] Agent mode system message is ≤ 4 800 chars for the profile block
- [ ] `null` profile → empty string, no crash
- [ ] Long `architectureSummary` is truncated at 400 chars

---
---

# Part 2 — Usage Metering in Dollars

## What This Does & Why

Trove already tracks token usage per agent run via `emptyAgentRunTokenTotals()`
and `addUsageToRunTotals()` in `chatThreadService.ts`. But these totals:

- Are in-memory only (lost on restart)
- Are in token counts, not dollars
- Are logged as a debug string (`formatAgentRunTokenSummary`), not surfaced in UI

This guide adds a full metering layer:

- Dollar cost calculated per turn from a provider/model price table
- Accumulated by thread, by provider, and by calendar day
- Persisted to `IStorageService` (survives restarts)
- Shown in Settings → Usage as a dashboard with a per-day spend chart
- Optional monthly budget cap that blocks new agent turns when exceeded

---

## Architecture

```
chatThreadService.ts  onFinalMessage  ←  usage: LLMMessageUsage, modelSelection
         │
         ▼  IUsageMeteringService.recordTurn(usage, providerName, modelName, threadId)
         │
         ▼
browser/usageMeteringService.ts
  ├── calculateTurnCostUSD()     from common/llmPricing.ts
  ├── accumulate into MeteringSession
  │     ├── byProvider: Record<string, {costUSD, turns}>
  │     ├── byThread:   Record<string, {costUSD, turns}>
  │     └── dailyUSD:   Record<'YYYY-MM-DD', number>
  └── IStorageService.store(STORAGE_KEY_METERING_SESSION)
         │
         ▼
browser/react/src/trove-settings-tsx/UsageDashboard.tsx
  ├── Session total ($x.xx)
  ├── Today ($x.xx)   ←  budgetPct progress bar if budget is set
  ├── Last 7 days     ←  sparkline bar chart
  ├── By provider     ←  sorted table
  └── Budget + Reset controls
```

---

## File Manifest

| Action | Path |
|---|---|
| CREATE | `common/llmPricing.ts` |
| CREATE | `common/usageMeteringTypes.ts` |
| CREATE | `browser/usageMeteringService.ts` |
| CREATE | `browser/react/src/trove-settings-tsx/UsageDashboard.tsx` |
| MODIFY | `common/storageKeys.ts` |
| MODIFY | `browser/chatThreadService.ts` |
| MODIFY | `browser/react/src/trove-settings-tsx/Settings.tsx` |
| MODIFY | `browser/trove.contribution.ts` |

---

## FILE 4 — `common/storageKeys.ts` (MODIFY)

Append to the existing file:

```typescript
// ── Usage metering ────────────────────────────────────────────────────────────

/** Rolling MeteringSession (daily buckets, per-provider, per-thread). */
export const STORAGE_KEY_METERING_SESSION = 'trove.metering.session';

/** Optional monthly budget cap in USD (string-serialised float). */
export const STORAGE_KEY_METERING_BUDGET  = 'trove.metering.budget';
```

---

## FILE 5 — `common/llmPricing.ts` (CREATE)

```typescript
/*
 * llmPricing.ts
 * Static per-model pricing table and cost calculator.
 *
 * common/ — no Node.js, no DOM, pure functions only.
 *
 * Maintenance:
 *   Update prices when providers publish rate changes.
 *   Add a `lastUpdated` date per provider so the UI can warn when
 *   the table is > 60 days old.
 *
 * All prices are USD per 1 000 000 tokens.
 */

import type { ProviderName } from './troveSettingsTypes.js';
import type { LLMMessageUsage } from './llmMessageUsage.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelPricing {
  /** USD / 1M input tokens */
  inputPer1M: number;
  /** USD / 1M output tokens */
  outputPer1M: number;
  /** USD / 1M cache-read tokens (Anthropic cache_read, OpenAI cached_tokens, Gemini cached) */
  cacheReadPer1M: number;
  /** USD / 1M cache-write tokens (Anthropic cache_creation only; 0 for all other providers) */
  cacheWritePer1M: number;
}

// ── Price table ───────────────────────────────────────────────────────────────
// Prices as of June 2026 — verify at provider pricing pages before shipping.

const PRICING: Partial<Record<ProviderName, Record<string, ModelPricing>>> = {

  anthropic: {
    // https://www.anthropic.com/pricing
    'claude-opus-4-8':    { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50,  cacheWritePer1M: 18.75 },
    'claude-opus-4-7':    { inputPer1M: 15.00, outputPer1M: 75.00, cacheReadPer1M: 1.50,  cacheWritePer1M: 18.75 },
    'claude-sonnet-4-6':  { inputPer1M: 3.00,  outputPer1M: 15.00, cacheReadPer1M: 0.30,  cacheWritePer1M: 3.75  },
    'claude-haiku-4-5':   { inputPer1M: 0.80,  outputPer1M: 4.00,  cacheReadPer1M: 0.08,  cacheWritePer1M: 1.00  },
  },

  openAI: {
    // https://openai.com/api/pricing
    'gpt-5.5':            { inputPer1M: 5.00,  outputPer1M: 20.00, cacheReadPer1M: 2.50,  cacheWritePer1M: 0 },
    'gpt-5.4':            { inputPer1M: 5.00,  outputPer1M: 20.00, cacheReadPer1M: 2.50,  cacheWritePer1M: 0 },
    'gpt-5.4-mini':       { inputPer1M: 0.15,  outputPer1M: 0.60,  cacheReadPer1M: 0.075, cacheWritePer1M: 0 },
    'gpt-5.3-chat-latest':{ inputPer1M: 5.00,  outputPer1M: 20.00, cacheReadPer1M: 2.50,  cacheWritePer1M: 0 },
  },

  gemini: {
    // https://ai.google.dev/gemini-api/docs/pricing
    'gemini-2.5-pro-preview-05-06':    { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.31,  cacheWritePer1M: 0 },
    'gemini-2.5-flash-preview-04-17':  { inputPer1M: 0.075,outputPer1M: 0.30,  cacheReadPer1M: 0.018, cacheWritePer1M: 0 },
    'gemini-2.0-flash':                { inputPer1M: 0.10, outputPer1M: 0.40,  cacheReadPer1M: 0.025, cacheWritePer1M: 0 },
    'gemini-2.0-flash-lite':           { inputPer1M: 0.075,outputPer1M: 0.30,  cacheReadPer1M: 0.018, cacheWritePer1M: 0 },
  },

  deepseek: {
    // https://api-docs.deepseek.com/quick_start/pricing
    'deepseek-chat':     { inputPer1M: 0.14,  outputPer1M: 0.28,  cacheReadPer1M: 0.014, cacheWritePer1M: 0 },
    'deepseek-reasoner': { inputPer1M: 0.55,  outputPer1M: 2.19,  cacheReadPer1M: 0.055, cacheWritePer1M: 0 },
  },

  groq: {
    // https://console.groq.com/docs/models
    'qwen-qwq-32b':              { inputPer1M: 0.29, outputPer1M: 0.39, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'llama-3.3-70b-versatile':   { inputPer1M: 0.59, outputPer1M: 0.79, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'llama-3.1-8b-instant':      { inputPer1M: 0.05, outputPer1M: 0.08, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  },

  mistral: {
    // https://mistral.ai/technology/
    'codestral-latest':          { inputPer1M: 0.30, outputPer1M: 0.90, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'mistral-large-latest':      { inputPer1M: 2.00, outputPer1M: 6.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'devstral-small-latest':     { inputPer1M: 0.10, outputPer1M: 0.30, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'ministral-8b-latest':       { inputPer1M: 0.10, outputPer1M: 0.10, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  },

  xAI: {
    // https://docs.x.ai/docs/models
    'grok-3':       { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'grok-3-mini':  { inputPer1M: 0.30, outputPer1M: 0.50,  cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'grok-3-fast':  { inputPer1M: 5.00, outputPer1M: 25.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
    'grok-2':       { inputPer1M: 2.00, outputPer1M: 10.00, cacheReadPer1M: 0, cacheWritePer1M: 0 },
  },

  openRouter: {
    // OpenRouter relays to upstream providers — no fixed price per model.
    // Costs are non-zero but unknown at build time.
    // Mark as null so the UI shows "~" rather than "$0.00".
  },

  // Self-hosted: no per-token cost
  ollama:          {},
  vLLM:            {},
  lmStudio:        {},
  liteLLM:         {},
  openAICompatible:{},
  googleVertex:    {},
  microsoftAzure:  {},
  awsBedrock:      {},
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Looks up pricing for a provider + model combination.
 * Performs prefix matching so "claude-opus-4-8-20250514" matches "claude-opus-4-8".
 * Returns null for self-hosted providers or unknown models.
 */
export const getModelPricing = (
  providerName: ProviderName,
  modelName: string,
): ModelPricing | null => {
  const table = PRICING[providerName];
  if (!table) return null;

  // Exact match first
  if (modelName in table) return table[modelName];

  // Prefix match (handles version-suffix variants like "claude-opus-4-8-20250514")
  for (const [key, pricing] of Object.entries(table)) {
    if (modelName.startsWith(key)) return pricing;
  }

  return null;
};

/**
 * Calculates the dollar cost of a single LLM turn.
 * Returns 0 for self-hosted or unrecognised models.
 */
export const calculateTurnCostUSD = (
  usage: LLMMessageUsage,
  providerName: ProviderName,
  modelName: string,
): number => {
  const pricing = getModelPricing(providerName, modelName);
  if (!pricing) return 0;

  return (
    (usage.inputTokens        / 1_000_000) * pricing.inputPer1M      +
    (usage.outputTokens       / 1_000_000) * pricing.outputPer1M     +
    (usage.cacheReadTokens    / 1_000_000) * pricing.cacheReadPer1M  +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
  );
};

/**
 * Whether we have a price table for this provider.
 * Used by the UI to show "~" (unknown cost) vs "$0.00" (confirmed free).
 */
export const hasKnownPricing = (providerName: ProviderName): boolean => {
  const table = PRICING[providerName];
  return table !== undefined && Object.keys(table).length > 0;
};

/** How old this price table's data is. Show a warning in UI if > 60 days. */
export const PRICING_TABLE_DATE = '2026-06-18';
```

---

## FILE 6 — `common/usageMeteringTypes.ts` (CREATE)

```typescript
/*
 * usageMeteringTypes.ts
 * Types for the usage metering feature.
 * common/ — no Node.js, no DOM, pure types only.
 */

// ── Per-turn record ───────────────────────────────────────────────────────────

export interface TurnCostRecord {
  timestamp:       number;   // Unix ms
  providerName:    string;
  modelName:       string;
  threadId:        string;
  inputTokens:     number;
  outputTokens:    number;
  cacheReadTokens: number;
  cacheWriteTokens:number;
  costUSD:         number;
}

// ── Session (persisted to IStorageService) ────────────────────────────────────

export interface ProviderTotals {
  costUSD: number;
  turns:   number;
}

export interface MeteringSession {
  /** Unix ms — when the session object was first created */
  startedAt:           number;
  totalCostUSD:        number;
  totalTurns:          number;
  totalInputTokens:    number;
  totalOutputTokens:   number;
  totalCacheReadTokens:number;
  /** Keyed by providerName */
  byProvider:          Record<string, ProviderTotals>;
  /** Keyed by threadId */
  byThread:            Record<string, ProviderTotals>;
  /**
   * Rolling daily spend in USD.
   * Keys are ISO date strings: "2026-06-18".
   * Entries older than 90 days are pruned on each write.
   */
  dailyUSD:            Record<string, number>;
}
```

---

## FILE 7 — `browser/usageMeteringService.ts` (CREATE)

```typescript
/*
 * browser/usageMeteringService.ts
 *
 * Accumulates per-turn LLM costs and persists them via IStorageService.
 * Called from chatThreadService.ts onFinalMessage whenever usage is available.
 *
 * All dollar calculations go through calculateTurnCostUSD() in common/llmPricing.ts
 * so the service itself is pure accumulation + storage — no pricing logic here.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { LLMMessageUsage } from '../common/llmMessageUsage.js';
import { ProviderName } from '../common/troveSettingsTypes.js';
import { calculateTurnCostUSD } from '../common/llmPricing.js';
import { MeteringSession } from '../common/usageMeteringTypes.js';
import {
  STORAGE_KEY_METERING_SESSION,
  STORAGE_KEY_METERING_BUDGET,
} from '../common/storageKeys.js';

// ── Service interface ─────────────────────────────────────────────────────────

export interface IUsageMeteringService {
  readonly _serviceBrand: undefined;

  /** Fires after every recordTurn() call. */
  readonly onDidUpdate: Event<MeteringSession>;

  /** Record one LLM turn. Called from chatThreadService.ts onFinalMessage. */
  recordTurn(opts: {
    usage:        LLMMessageUsage;
    providerName: ProviderName;
    modelName:    string;
    threadId:     string;
  }): void;

  getSession():             MeteringSession;
  getTodayCostUSD():        number;
  getThreadCostUSD(threadId: string): number;

  getBudgetLimitUSD():      number | null;
  setBudgetLimitUSD(usd: number | null): void;

  /** Clears all accumulated cost data (not the budget cap). */
  resetSession(): void;
}

export const IUsageMeteringService =
  createDecorator<IUsageMeteringService>('usageMeteringService');

// ── Implementation ────────────────────────────────────────────────────────────

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1_000;

const emptySession = (): MeteringSession => ({
  startedAt:            Date.now(),
  totalCostUSD:         0,
  totalTurns:           0,
  totalInputTokens:     0,
  totalOutputTokens:    0,
  totalCacheReadTokens: 0,
  byProvider:           {},
  byThread:             {},
  dailyUSD:             {},
});

class UsageMeteringService extends Disposable implements IUsageMeteringService {
  readonly _serviceBrand: undefined;

  private readonly _onDidUpdate = this._register(new Emitter<MeteringSession>());
  readonly onDidUpdate = this._onDidUpdate.event;

  private _session: MeteringSession;

  constructor(
    @IStorageService private readonly _storage: IStorageService,
  ) {
    super();
    this._session = this._load();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _load(): MeteringSession {
    try {
      const raw = this._storage.get(STORAGE_KEY_METERING_SESSION, StorageScope.APPLICATION);
      if (raw) return JSON.parse(raw) as MeteringSession;
    } catch { /* corrupt storage — start fresh */ }
    return emptySession();
  }

  private _persist(): void {
    this._storage.store(
      STORAGE_KEY_METERING_SESSION,
      JSON.stringify(this._session),
      StorageScope.APPLICATION,
      StorageTarget.USER,
    );
  }

  private _today(): string {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  private _pruneDailyBuckets(): void {
    const cutoffMs = Date.now() - NINETY_DAYS_MS;
    for (const day of Object.keys(this._session.dailyUSD)) {
      if (new Date(day).getTime() < cutoffMs) {
        delete this._session.dailyUSD[day];
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  recordTurn(opts: {
    usage:        LLMMessageUsage;
    providerName: ProviderName;
    modelName:    string;
    threadId:     string;
  }): void {
    const costUSD = calculateTurnCostUSD(opts.usage, opts.providerName, opts.modelName);
    const today = this._today();

    // Session-level totals
    this._session.totalCostUSD          += costUSD;
    this._session.totalTurns            += 1;
    this._session.totalInputTokens      += opts.usage.inputTokens;
    this._session.totalOutputTokens     += opts.usage.outputTokens;
    this._session.totalCacheReadTokens  += opts.usage.cacheReadTokens;

    // Per-provider rollup
    const prov = this._session.byProvider[opts.providerName]
      ?? (this._session.byProvider[opts.providerName] = { costUSD: 0, turns: 0 });
    prov.costUSD += costUSD;
    prov.turns   += 1;

    // Per-thread rollup
    const thread = this._session.byThread[opts.threadId]
      ?? (this._session.byThread[opts.threadId] = { costUSD: 0, turns: 0 });
    thread.costUSD += costUSD;
    thread.turns   += 1;

    // Daily bucket
    this._session.dailyUSD[today] = (this._session.dailyUSD[today] ?? 0) + costUSD;

    // Prune old buckets (run infrequently via modulo to avoid overhead on every turn)
    if (this._session.totalTurns % 20 === 0) this._pruneDailyBuckets();

    this._persist();
    this._onDidUpdate.fire({ ...this._session });
  }

  getSession(): MeteringSession {
    return { ...this._session };
  }

  getTodayCostUSD(): number {
    return this._session.dailyUSD[this._today()] ?? 0;
  }

  getThreadCostUSD(threadId: string): number {
    return this._session.byThread[threadId]?.costUSD ?? 0;
  }

  getBudgetLimitUSD(): number | null {
    const raw = this._storage.get(STORAGE_KEY_METERING_BUDGET, StorageScope.APPLICATION);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }

  setBudgetLimitUSD(usd: number | null): void {
    if (usd === null || usd <= 0) {
      this._storage.remove(STORAGE_KEY_METERING_BUDGET, StorageScope.APPLICATION);
    } else {
      this._storage.store(
        STORAGE_KEY_METERING_BUDGET,
        String(usd),
        StorageScope.APPLICATION,
        StorageTarget.USER,
      );
    }
    this._onDidUpdate.fire({ ...this._session });
  }

  resetSession(): void {
    this._session = emptySession();
    this._persist();
    this._onDidUpdate.fire({ ...this._session });
  }
}

registerSingleton(IUsageMeteringService, UsageMeteringService, InstantiationType.Delayed);
```

---

## FILE 8 — `browser/chatThreadService.ts` (MODIFY)

### Step 1 — Add import

```typescript
import { IUsageMeteringService } from './usageMeteringService.js';
```

### Step 2 — Inject via constructor

In `ChatThreadService`'s constructor parameter list, add:

```typescript
@IUsageMeteringService private readonly _usageMeteringService: IUsageMeteringService,
```

### Step 3 — Wire usage into `onFinalMessage`

Find the existing `onFinalMessage` callback (around line 1073–1074):

```typescript
// EXISTING:
onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, usage }) => {
  addUsageToRunTotals(runTokenTotals, usage)
  resMessageIsDonePromise(...)
},
```

Add one line after `addUsageToRunTotals`:

```typescript
onFinalMessage: async ({ fullText, fullReasoning, toolCall, anthropicReasoning, usage }) => {
  addUsageToRunTotals(runTokenTotals, usage);

  // ← ADD: persist dollar cost to metering service
  if (usage && modelSelection) {
    this._usageMeteringService.recordTurn({
      usage,
      providerName: modelSelection.providerName,
      modelName:    modelSelection.modelName,
      threadId,
    });
  }

  resMessageIsDonePromise({ type: 'llmDone', toolCall, info: { fullText, fullReasoning, anthropicReasoning } });
},
```

### Step 4 — Budget hard stop (optional but recommended)

At the top of the agent loop, before calling `sendLLMMessage`, add:

```typescript
// Budget guard — block new turns if monthly cap exceeded
const budgetUSD = this._usageMeteringService.getBudgetLimitUSD();
if (budgetUSD !== null) {
  const spent = this._usageMeteringService.getSession().totalCostUSD;
  if (spent >= budgetUSD) {
    this._setStreamState(threadId, {
      isRunning: undefined,
      error: {
        message: `Monthly budget of $${budgetUSD.toFixed(2)} reached ($${spent.toFixed(4)} spent). Reset in Settings → Usage.`,
        fullError: null,
      },
    });
    break; // exit the agent loop
  }
}
```

Place this block immediately before the `sendLLMMessage` call inside the
agent loop (look for the comment `// send the message`).

---

## FILE 9 — `browser/react/src/trove-settings-tsx/UsageDashboard.tsx` (CREATE)

```tsx
/*
 * UsageDashboard.tsx
 * Settings panel that shows cumulative LLM spend and lets users set a budget.
 *
 * Sections:
 *   1. Top-line numbers: session total + today
 *   2. Budget indicator (progress bar, shown only when budget is set)
 *   3. 7-day sparkline bar chart
 *   4. Per-provider breakdown table
 *   5. Budget control + Reset button
 *
 * Uses only VS Code CSS variables for theming — no hardcoded colours.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useService } from '../util/services.jsx';
import { IUsageMeteringService } from '../../../../usageMeteringService.js';
import type { MeteringSession } from '../../../../../common/usageMeteringTypes.js';
import { PRICING_TABLE_DATE } from '../../../../../common/llmPricing.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (usd: number): string => {
  if (usd === 0)     return '$0.00';
  if (usd < 0.0001)  return '< $0.0001';
  if (usd < 0.01)    return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
};

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `${(n / 1_000).toFixed(1)}k`
  : String(n);

const dayLabel = (isoDate: string): string => {
  const d = new Date(isoDate);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// ── Component ─────────────────────────────────────────────────────────────────

export function UsageDashboard() {
  const meteringService = useService(IUsageMeteringService);

  const [session, setSession]     = useState<MeteringSession>(meteringService.getSession());
  const [budgetUSD, setBudgetUSD] = useState<number | null>(meteringService.getBudgetLimitUSD());
  const [budgetInput, setBudgetInput] = useState<string>(
    meteringService.getBudgetLimitUSD()?.toString() ?? ''
  );

  useEffect(() => {
    const sub = meteringService.onDidUpdate(s => {
      setSession(s);
      setBudgetUSD(meteringService.getBudgetLimitUSD());
    });
    return () => sub.dispose();
  }, [meteringService]);

  // ── Derived data ────────────────────────────────────────────────────────

  const today = new Date().toISOString().slice(0, 10);
  const todayUSD = session.dailyUSD[today] ?? 0;

  const last7 = Object.entries(session.dailyUSD)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7);

  const maxDayUSD = Math.max(...last7.map(([, v]) => v), 0.001);

  const providerRows = Object.entries(session.byProvider)
    .sort(([, a], [, b]) => b.costUSD - a.costUSD);

  const budgetPct = budgetUSD && budgetUSD > 0
    ? Math.min(100, (session.totalCostUSD / budgetUSD) * 100)
    : null;

  const pricingAgeMs = Date.now() - new Date(PRICING_TABLE_DATE).getTime();
  const pricingIsOld = pricingAgeMs > 60 * 24 * 60 * 60 * 1_000; // > 60 days

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleSetBudget = useCallback(() => {
    const val = budgetInput.trim() === '' ? null : parseFloat(budgetInput);
    meteringService.setBudgetLimitUSD(val && isFinite(val) ? val : null);
  }, [budgetInput, meteringService]);

  const handleReset = useCallback(() => {
    if (window.confirm('Reset all accumulated usage data? This cannot be undone.')) {
      meteringService.resetSession();
    }
  }, [meteringService]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '0 16px 24px', maxWidth: 480 }}>

      {/* Section header */}
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 12px', color: 'var(--vscode-foreground)' }}>
        LLM Usage & Cost
      </h3>

      {/* Pricing table age warning */}
      {pricingIsOld && (
        <div style={{ fontSize: 11, color: 'var(--vscode-editorWarning-foreground)', marginBottom: 10 }}>
          ⚠ Pricing table was last updated {PRICING_TABLE_DATE}. Costs may be inaccurate.
        </div>
      )}

      {/* Top-line numbers */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
        <StatCard label="Session total" value={fmt(session.totalCostUSD)} sub={`${session.totalTurns} turns`} />
        <StatCard label="Today"         value={fmt(todayUSD)} />
        <StatCard label="Cache ratio"
          value={session.totalInputTokens > 0
            ? `${((session.totalCacheReadTokens / session.totalInputTokens) * 100).toFixed(0)}%`
            : '—'}
          sub="of input tokens"
        />
      </div>

      {/* Token breakdown */}
      <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 14 }}>
        {fmtTokens(session.totalInputTokens)} in ·{' '}
        {fmtTokens(session.totalOutputTokens)} out ·{' '}
        {fmtTokens(session.totalCacheReadTokens)} cache-read
      </div>

      {/* Budget indicator */}
      {budgetPct !== null && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
              Budget: {fmt(session.totalCostUSD)} of {fmt(budgetUSD!)}
            </span>
            <span style={{ color: budgetPct > 90 ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)' }}>
              {budgetPct.toFixed(1)}%
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--vscode-progressBar-background)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${budgetPct}%`,
              background: budgetPct > 90
                ? 'var(--vscode-errorForeground)'
                : budgetPct > 75
                  ? 'var(--vscode-editorWarning-foreground)'
                  : 'var(--vscode-button-background)',
              transition: 'width 0.3s ease, background 0.3s ease',
            }} />
          </div>
        </div>
      )}

      {/* 7-day sparkline */}
      {last7.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
            LAST 7 DAYS
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 48 }}>
            {last7.map(([day, cost]) => (
              <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div
                  title={`${dayLabel(day)}: ${fmt(cost)}`}
                  style={{
                    width: '100%',
                    height: `${Math.max(2, (cost / maxDayUSD) * 40)}px`,
                    background: day === today
                      ? 'var(--vscode-button-background)'
                      : 'var(--vscode-button-secondaryBackground)',
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', opacity: 0.7 }}>
                  {dayLabel(day).split(' ')[1]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-provider table */}
      {providerRows.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
            BY PROVIDER
          </div>
          {providerRows.map(([provider, data]) => (
            <div key={provider} style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              padding: '4px 0',
              borderBottom: '1px solid var(--vscode-editorGroup-border)',
            }}>
              <span style={{ color: 'var(--vscode-foreground)' }}>{provider}</span>
              <span style={{ color: 'var(--vscode-descriptionForeground)' }}>
                {fmt(data.costUSD)} · {data.turns} turn{data.turns !== 1 ? 's' : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Budget control */}
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--vscode-descriptionForeground)' }}>
        MONTHLY BUDGET (USD)
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          type="number"
          min="0"
          step="1"
          placeholder="No limit"
          value={budgetInput}
          onChange={e => setBudgetInput(e.target.value)}
          style={{
            flex: 1,
            background: 'var(--vscode-input-background)',
            color: 'var(--vscode-input-foreground)',
            border: '1px solid var(--vscode-input-border)',
            borderRadius: 3,
            padding: '4px 8px',
            fontSize: 12,
          }}
        />
        <button onClick={handleSetBudget} style={actionBtn('primary')}>Set</button>
        {budgetUSD !== null && (
          <button onClick={() => { setBudgetInput(''); meteringService.setBudgetLimitUSD(null); }} style={actionBtn('secondary')}>
            Clear
          </button>
        )}
      </div>

      {budgetUSD !== null && (
        <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>
          Agent turns will be blocked when total session cost reaches {fmt(budgetUSD)}.
        </div>
      )}

      {/* Reset button */}
      <button onClick={handleReset} style={{ ...actionBtn('danger'), marginTop: 8 }}>
        Reset all usage data
      </button>

      {/* Disclaimer */}
      <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.6, marginTop: 12 }}>
        Costs are estimates based on Trove's built-in pricing table and may differ
        from your actual provider invoice. Self-hosted models (Ollama, vLLM, LM Studio)
        show $0.00 as there is no per-token cost.
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      flex: 1,
      padding: '8px 10px',
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-editorGroup-border)',
      borderRadius: 4,
    }}>
      <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--vscode-foreground)' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', opacity: 0.7 }}>{sub}</div>}
    </div>
  );
}

function actionBtn(variant: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = { fontSize: 11, padding: '4px 10px', cursor: 'pointer', borderRadius: 3, border: 'none' };
  if (variant === 'primary')   return { ...base, background: 'var(--vscode-button-background)',          color: 'var(--vscode-button-foreground)' };
  if (variant === 'secondary') return { ...base, background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)' };
  return { ...base, background: 'transparent', color: 'var(--vscode-errorForeground)', border: '1px solid var(--vscode-errorForeground)' };
}
```

---

## FILE 10 — `browser/react/src/trove-settings-tsx/Settings.tsx` (MODIFY)

Add a "Usage" tab to the existing tab bar. Find the tab definitions
(look for the array that contains tabs like `'Model'`, `'Provider'`, etc.)
and add `'Usage'` as the last entry.

Then in the tab content switch/conditional block, add the Usage panel:

```tsx
// Add import at top:
import { UsageDashboard } from './UsageDashboard.jsx';

// Add to the tab list (wherever the other tab labels are defined):
| 'Usage'  // ← add this

// Add to the render switch / conditional:
{activeTab === 'Usage' && <UsageDashboard />}
```

---

## FILE 11 — `browser/trove.contribution.ts` (MODIFY)

Add import at the top:

```typescript
import { IUsageMeteringService } from './usageMeteringService.js';
```

The `registerSingleton` call at the bottom of `usageMeteringService.ts`
handles registration automatically. The import here is what pulls
that module into the bundle.

---

## Complete Data Flow Diagram

```
User sends message
      │
      ▼
chatThreadService._addUserMessageAndStreamResponse()
      │   agent loop starts
      ├── turn 1 LLM call → onFinalMessage({ usage, ... })
      │         │
      │         ├── addUsageToRunTotals(runTokenTotals, usage)   [existing]
      │         │
      │         └── usageMeteringService.recordTurn({            [NEW]
      │               usage,
      │               providerName: modelSelection.providerName,
      │               modelName:    modelSelection.modelName,
      │               threadId
      │             })
      │               │
      │               ├── calculateTurnCostUSD()  → costUSD
      │               ├── session.totalCostUSD   += costUSD
      │               ├── session.byProvider[p]  += costUSD
      │               ├── session.byThread[t]    += costUSD
      │               ├── session.dailyUSD[today]+= costUSD
      │               └── IStorageService.store(SESSION_KEY, JSON)
      │
      ├── turn 2 ... turn N (each fires same chain)
      │
      └── loop ends → formatAgentRunTokenSummary logs to console [existing]
                     UsageDashboard re-renders via onDidUpdate   [NEW]
```

---

## Testing Checklist (Part 2)

### Pricing table
- [ ] `calculateTurnCostUSD()` returns 0 for Ollama (self-hosted)
- [ ] `calculateTurnCostUSD()` returns correct value for Anthropic Claude Sonnet
  - 1000 input + 100 output + 0 cache = (1000/1M × $3) + (100/1M × $15) = $0.000003 + $0.0000015 = $0.0000045
- [ ] Prefix matching: `'claude-opus-4-8-20250514'` resolves to `claude-opus-4-8` pricing
- [ ] `hasKnownPricing('ollama')` → false; `hasKnownPricing('anthropic')` → true

### Service behaviour
- [ ] Session persists across VS Code restart (check IStorageService store/load)
- [ ] `totalTurns` increments by 1 per `onFinalMessage` callback
- [ ] `byProvider['anthropic'].costUSD` equals sum of individual turn costs for Anthropic
- [ ] `dailyUSD[today]` accumulates correctly across multiple turns in one day
- [ ] Daily buckets older than 90 days are pruned

### Budget hard stop
- [ ] With budget $0.01, agent loop exits after totalCostUSD ≥ 0.01
- [ ] Error message shown in stream state with exact spent + budget values
- [ ] `setBudgetLimitUSD(null)` removes budget; agent runs freely again

### Dashboard UI
- [ ] Session total and today values update immediately after each turn
- [ ] 7-day bar chart renders with today's bar highlighted
- [ ] Today's bar height is proportional to the busiest day
- [ ] Provider table sorted by cost descending
- [ ] Budget progress bar turns red when ≥ 90%
- [ ] Reset confirmation dialog appears; session resets to $0.00 after confirm
- [ ] Pricing-age warning shows for PRICING_TABLE_DATE > 60 days old
- [ ] Self-hosted providers show $0.00 with no error

---

## Pricing Table Maintenance

When providers update their rates:

1. Update `PRICING` in `common/llmPricing.ts`
2. Update `PRICING_TABLE_DATE` to today's date
3. Update any new model names in the relevant provider block
4. Run the cost calculation test to verify unchanged models still produce
   the expected dollar amounts

The UI will automatically hide the stale-pricing warning once
`PRICING_TABLE_DATE` is within 60 days of today.

---

## Summary: What Each File Does

| File | Purpose |
|---|---|
| `common/repoIntelligenceTypes.ts` | Add `REPO_PROFILE_MAX_CHARS` per-mode token caps |
| `common/prompt/prompts.ts` | Replace thin `buildRepoContextBlock()` with rich `serializeWorkspaceProfileForPrompt()` |
| `browser/convertToLLMMessageService.ts` | Add staleness guard + background refresh trigger |
| `common/storageKeys.ts` | Two new storage keys for metering |
| `common/llmPricing.ts` | Static price table + `calculateTurnCostUSD()` |
| `common/usageMeteringTypes.ts` | `MeteringSession` and `TurnCostRecord` types |
| `browser/usageMeteringService.ts` | Accumulate costs + persist + `IUsageMeteringService` interface |
| `browser/chatThreadService.ts` | Wire `recordTurn()` into existing `onFinalMessage` callback |
| `browser/react/.../UsageDashboard.tsx` | Settings UI: sparkline, provider table, budget control |
| `browser/react/.../Settings.tsx` | Add Usage tab |
| `browser/trove.contribution.ts` | Import to pull `registerSingleton` into bundle |
