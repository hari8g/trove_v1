# RIAF_CONTEXT_DOC — Implementation Build Guide (Agent Mode Revision)
**Feature:** Repository Intelligence Agent Feed → `TROVE_CONTEXT.md` generator
**Trove repo:** `github.com/hari8g/trove_v1`
**Base path:** `src/vs/workbench/contrib/trove/`
**Revision:** Gather Mode pipeline → Agent Mode orchestration

---

## Why This Revision Exists

The original design ran a hand-rolled 5-phase pipeline in `electron-main` using
**Gather mode** (read-only). That approach required 300+ lines of custom orchestration:
a dedicated `RiafService`, a bespoke `RiafChannel`, new IPC registration, 2 new SQLite
tables, a per-file micro-summary parser, and manual batch sizing logic.

**All of that is redundant.** Agent mode already owns every piece:

| What gather pipeline hand-rolled | What agent mode already has |
|---|---|
| Parallel file reads in batches of 6 | `parallelReadToolBatch.ts` — up to 5 reads per turn |
| Token budget enforcement | `contextWindowTrim.ts` + `wireMessageTrim.ts` |
| Stale result compression | `toolResultCompaction.ts` — 8 compactable tools |
| Phase progress tracking | `agentPlan.ts` — live plan with `markPlanItemDoneForTool` |
| Completion detection | `agentDeliveryService.ts` + `onDidFinishAgentRun` event |
| File write at the end | `create_file_or_folder` built-in tool |
| Custom IPC plumbing | `chatThreadService.addUserMessageAndStreamResponse()` |

The new design is: **one well-crafted agent prompt → the existing agent loop does
everything else**. No electron-main changes. No new IPC channel. No new DB tables.

---

## What This Feature Does (unchanged)

A one-click command in Trove that triggers a fully autonomous agent run which analyses
the open repository using Trove's existing tool set, then synthesises a comprehensive
`TROVE_CONTEXT.md` at the workspace root.

The document is the user's **persistent context source** — they tag it into any chat
window (`@TROVE_CONTEXT.md`) and the agent has full codebase understanding without
re-reading anything.

---

## New Architecture

```
User: "Analyse Repo" button (ContextDocPanel.tsx in SidebarChat.tsx)
          │
          ▼ direct service call — no IPC, no electron-main
┌─────────────────────────────────────────────────────────────┐
│  browser/riafAgentService.ts (NEW — ~80 lines)              │
│    1. chatThreadService.openNewThread()                     │
│    2. settingsService.setGlobalSettings({ chatMode:'agent'})│
│    3. chatThreadService.addUserMessageAndStreamResponse(    │
│         RIAF_AGENT_PROMPT + workspaceRoot)                  │
│    4. listen onDidFinishAgentRun → notify ContextDocPanel   │
└─────────────────────────────────────────────────────────────┘
          │ (no IPC cross-process boundary)
          ▼
┌─────────────────────────────────────────────────────────────┐
│  chatThreadService.ts  (EXISTING — ZERO CHANGES)            │
│                                                             │
│  generateAgentPlan()                                        │
│    → "Get dir tree / Read key files / Synthesise / Write"   │
│                                                             │
│  Agent loop — agent drives itself:                          │
│    Turn 1:  get_dir_tree(root)                              │
│             + parallelReadToolBatch discovers 4 more reads  │
│    Turn 2:  read_file(package.json)  ← batched ×5          │
│             read_file(tsconfig.json)                        │
│             read_file(src/main.ts)                          │
│             read_file(src/app.ts)                           │
│             ls_dir(src/)                                    │
│    Turn N:  search_codebase("IPC channel")                  │
│             search_for_files("*.service.ts")                │
│    Final:   create_file_or_folder(TROVE_CONTEXT.md, <doc>)  │
│                                                             │
│  toolResultCompaction  — stale reads auto-compacted         │
│  contextWindowTrim     — 85% budget enforced automatically  │
│  wireMessageTrim       — char budget at wire level          │
│  agentDeliveryService  — onDidFinishAgentRun fires          │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
browser: ContextDocPanel.tsx (NEW — ~120 lines, simpler than original)
  - Shows agent plan via existing onDidChangeCurrentThread
  - Shows "Open TROVE_CONTEXT.md" on onDidFinishAgentRun
  - No custom progress bar or phase enum needed
```

**Architectural law compliance (unchanged):**
- `common/riaf/` — types + prompts only, zero Node/DOM imports
- `browser/` — service wrapper + React UI only
- Reuses `addUserMessageAndStreamResponse()` from `chatThreadService.ts`
- Reuses all existing agent tools, planning, compaction, and trim infrastructure
- **`electron-main/` receives zero new files** — this is the key improvement

---

## File Manifest (Revamped)

### Files to CREATE

| Path | Lines | Notes |
|---|---|---|
| `common/riaf/riafTypes.ts` | ~50 | Simpler — no FileMicroSummary, no phase union |
| `common/riaf/riafPrompts.ts` | ~180 | Single agent prompt + 12-section template |
| `browser/riafAgentService.ts` | ~80 | Thin trigger — open thread, set mode, send message |
| `browser/react/src/sidebar-tsx/ContextDocPanel.tsx` | ~120 | Simpler — no custom progress bar |

### Files to MODIFY

| Path | Change |
|---|---|
| `browser/trove.contribution.ts` | Register `IRiafAgentService` singleton + keybinding |
| `browser/react/src/sidebar-tsx/SidebarChat.tsx` | Add `<ContextDocPanel />` |

### Files REMOVED vs Original Guide

| Original path | Why removed |
|---|---|
| `electron-main/repoIntelligence/riafService.ts` | Agent loop replaces entire pipeline |
| `electron-main/repoIntelligence/riafChannel.ts` | No custom IPC needed |
| `common/repoIntelligenceTypes.ts` (modification) | No `RIAF_CHANNEL` re-export needed |
| `electron-main/repoIntelligence/repoIntelligenceDb.ts` (modification) | No new SQLite tables |
| Main process IPC registration in `app.ts` | No electron-main service to register |

---

## FILE 1 — `common/riaf/riafTypes.ts` (CREATE)

```typescript
/*
 * riafTypes.ts
 * Types for the RIAF (Repository Intelligence Agent Feed) feature.
 * common/ — no Node.js, no DOM, no side-effects.
 *
 * Compared to the gather-mode design, this file is intentionally minimal:
 * there is no RiafProgress discriminated union, no FileMicroSummary, and no
 * phase enum — all of that is now handled by the existing agent loop.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface RiafConfig {
  /**
   * Output filename written to the workspace root.
   * Default: 'TROVE_CONTEXT.md'
   */
  outputFileName: string;

  /**
   * Maximum number of source files the agent is instructed to read.
   * The agent itself decides which files are most important within this cap.
   * Default: 80
   */
  maxFiles: number;

  /**
   * Include test files in analysis.
   * Default: false (test files are rarely needed for codebase context docs).
   */
  includeTests: boolean;
}

export const DEFAULT_RIAF_CONFIG: RiafConfig = {
  outputFileName: 'TROVE_CONTEXT.md',
  maxFiles: 80,
  includeTests: false,
};

// ── Run state ─────────────────────────────────────────────────────────────────

/**
 * Lifecycle of a RIAF agent run, surfaced to the ContextDocPanel.
 * Kept simple — actual progress detail comes from the agent thread's
 * plan messages and tool activity (rendered by existing sidebar components).
 */
export type RiafRunState =
  | { status: 'idle' }
  | { status: 'running'; threadId: string }
  | { status: 'done';    threadId: string; outputPath: string }
  | { status: 'error';   threadId: string; message: string };

// ── Service interface ─────────────────────────────────────────────────────────

export interface IRiafAgentService {
  readonly _serviceBrand: undefined;

  /** Current run state. Re-reads from chatThreadService on each call. */
  readonly state: RiafRunState;

  /** Fires whenever state changes. */
  readonly onDidChangeState: Event<RiafRunState>;

  /**
   * Opens a fresh agent thread, sets mode to 'agent', and sends the
   * RIAF_AGENT_PROMPT as the first user message.
   * No-op if a run is already in progress.
   */
  startRun(config?: Partial<RiafConfig>): Promise<void>;

  /** Aborts the running agent thread (if any). */
  abort(): Promise<void>;
}

export const IRiafAgentService = createDecorator<IRiafAgentService>('riafAgentService');
```

---

## FILE 2 — `common/riaf/riafPrompts.ts` (CREATE)

```typescript
/*
 * riafPrompts.ts
 * The single agent prompt for the RIAF pipeline.
 *
 * Design notes vs the gather-mode version:
 *
 * OLD: 3 prompts (micro-summary, manifest parse, synthesis) + a parser for each.
 *      The micro-summary was called N times — once per file.
 *      Total LLM calls: N (analysis) + 1 (synthesis) = ~80–100 calls for a medium repo.
 *
 * NEW: 1 prompt. The agent itself decides what to read and when.
 *      Total LLM calls: the number of agent turns (typically 8–15 for a medium repo).
 *      parallelReadToolBatch batches up to 5 reads per turn automatically.
 *      toolResultCompaction keeps old reads from consuming the context budget.
 *
 * Prompt quality levers (same guidance as before, different location):
 *   - More thorough wiring section: add "for every service, trace its full call chain"
 *   - Shorter output: add "[max 120 words per section]" constraints
 *   - More accurate cookbook: add "every recipe MUST reference an existing file as example"
 *   - Force full file coverage: add a checklist of must-read file patterns
 */

import type { RiafConfig } from './riafTypes.js';

// ── TROVE_CONTEXT.md section template ─────────────────────────────────────────
//
// This template is embedded in the user message the agent receives.
// The agent fills it in based on what it discovers using its tools.
// Section order and headings are fixed — the agent is instructed not to alter them.

const CONTEXT_DOC_TEMPLATE = `\
# TROVE_CONTEXT.md
> Auto-generated by Trove RIAF · {projectName} · {date}
> Tag this file in the Trove sidebar for full codebase context.

---

## 1. What This Repository Does

[2–3 paragraphs. Purpose, target users, key capabilities. No bullet lists here.
Every sentence must be specific to this codebase — zero generic boilerplate.]

---

## 2. Architecture Overview

\`\`\`
[ASCII diagram showing layers, major components, and how they connect.
Use → for data flow, ─ for layer boundaries, clear labels on every box.
For VS Code extensions: show browser / electron-main / common separation.]
\`\`\`

[2 paragraphs explaining the key architectural decisions and layer boundary rules.
Quote actual constraint names found in source files if present.]

---

## 3. File Responsibility Map

[Annotated directory tree. Every non-trivial file/directory gets a ← comment.
Format: path/to/file.ts     ← what it owns
Skip: node_modules, dist, build, .git, coverage, lock files, generated files.]

---

## 4. Module Wiring & Data Flow

[MOST IMPORTANT SECTION — write this in detail. Every subsystem gets a sub-header.
For each subsystem:
  - Entry point (what triggers it, including the exact file + method)
  - Full call chain: File.method() → File.method() → File.method()
  - What goes in (params/types) and what comes out (return type/events)
  - Side effects: DB writes, file writes, IPC events, UI state changes

Do NOT write "X calls Y". Write "X.methodName() calls Y.otherMethod(params)".]

---

## 5. External Dependencies

[Group by category. For each dependency:
**package-name** (\`version\`) — one-sentence purpose, which files import it.

Categories to use: Core Runtime | UI/Rendering | State | Data/DB | Networking | Build & Tooling | Testing]

---

## 6. Entry Points & Bootstrap Sequence

[Numbered ordered list. What runs first, what it initialises, in what order.
Include the actual file paths and key method names at each step.]

---

## 7. Key Patterns & Conventions

[Rules an engineer MUST follow to add code that fits this codebase.
Only rules that are ACTUALLY enforced in the analysed files — no guesses.
Examples of the kind of thing to include:
  - Service registration pattern (e.g. registerSingleton in contribution.ts)
  - IPC event convention (e.g. this._channel.listen<T>() not plain EventEmitter)
  - Write tool guard (e.g. write tools require ctx.sandboxId)
  - Naming conventions, file placement rules, import constraints]

---

## 8. Implementation Cookbook

[Step-by-step recipes for the 4–6 most common additions to this codebase.
Base each recipe STRICTLY on existing patterns found in the files you read.
Every recipe must cite a specific existing file as a reference example.

### How to add a new [X]
1. Create \`path/new-file.ts\` — follow the pattern in \`path/existing-file.ts\`
2. Register in \`path/contribution.ts\`
3. Add IPC method in \`path/channel.ts\` (if cross-process)
4. ...]

---

## 9. Configuration & Environment

[Every config file and what it controls.
Every env var: name | purpose | required? | example value]

---

## 10. Testing

[Test framework, where test files live, naming convention, how to run.
List the test suites that exist with a one-line description of each.]

---

## 11. Known Issues & TODOs

[Every TODO / FIXME / HACK / NOTE comment you found in the files you read.
Quote the comment verbatim and cite the file path.
Group by file.]

---

## 12. Quick Reference

[Max 25 bullets. The most-reached-for facts when actively working in this codebase.
Think: "what would I wish I knew on day 1?"]`;

// ── Agent prompt builder ───────────────────────────────────────────────────────

/**
 * Builds the user message sent to start the RIAF agent run.
 *
 * This is the only prompt in the agent-mode RIAF pipeline. The agent receives
 * this as its first user message and then autonomously:
 *   1. Discovers the workspace structure with get_dir_tree / ls_dir
 *   2. Reads key files (batched automatically by parallelReadToolBatch)
 *   3. Uses search_codebase / search_for_files to fill in gaps
 *   4. Writes the completed document with create_file_or_folder
 *
 * Token budget guidance:
 *   - This prompt itself: ~700 tokens
 *   - Tool reads per turn: auto-batched, auto-compacted
 *   - Synthesis turn (writing the doc): largest output (~4k–8k tokens)
 *   - Typical total cost: 12–20 agent turns × model input cost
 */
export const buildRiafAgentPrompt = (
  workspaceRoot: string,
  config: RiafConfig,
): string => {
  const outputPath = `${workspaceRoot}/${config.outputFileName}`;
  const testClause = config.includeTests
    ? 'Include test files in your analysis.'
    : 'You may skip test files (*.test.ts, *.spec.ts, __tests__/) unless they reveal important patterns.';

  return `\
You are performing a full repository analysis to generate a comprehensive \
context document that will be used as the primary context source for an \
AI coding assistant.

## Your Task

Analyse the repository at: ${workspaceRoot}

Then write the completed document to: ${outputPath}

## How to Execute This

Work through these phases using your tools:

**Phase 1 — Structure discovery**
Use get_dir_tree on the workspace root to understand the overall layout.
Use ls_dir on each major subdirectory to get detail.
Use search_for_files to locate key files (package.json, tsconfig.json,
README.md, main entry points, contribution/registration files).

**Phase 2 — Deep reading**
Read the most architecturally significant files. Prioritise:
  - Entry points and bootstrap files
  - Service/channel/interface definitions
  - Contribution and registration files
  - Type declaration files
  - The largest and most-imported service files
Use search_codebase to trace specific patterns (IPC channels, service
registration, tool definitions, data flow patterns).
${testClause}
Read up to ${config.maxFiles} files total — focus on the ones that reveal
HOW the codebase is wired, not just what individual functions do.

**Phase 3 — Write the document**
Once you have sufficient understanding (you do NOT need to read every file),
use create_file_or_folder to write the completed document.
Do not ask for confirmation before writing — just write it.

## Output Format

Fill in the template below exactly. Do not add, rename, or remove sections.
Replace every [...] block with real content derived from what you read.
Every sentence must be specific to THIS codebase — zero generic boilerplate.
Section 4 (Module Wiring) and Section 8 (Cookbook) are the most important —
spend the most effort on those two.

${CONTEXT_DOC_TEMPLATE}`;
};

// ── Prompt quality checklist (for developers tuning the prompt) ───────────────
//
// After a run, verify the output passes these checks before shipping:
//
// Section 4 quality:
//   □ Call chains use "File.method() → File.method()" format, not just file names
//   □ Every major subsystem has its own sub-header
//   □ Side effects (IPC events, DB writes, UI state) are listed
//
// Section 8 quality:
//   □ Every recipe cites an existing file as a reference example
//   □ Steps are concrete file paths + method names, not generic instructions
//   □ Covers the 4–6 most common contribution patterns for THIS codebase
//
// Anti-patterns to search for and reject:
//   □ "comprehensive", "robust", "scalable" — generic, ban them
//   □ "The codebase follows best practices" — meaningless, ban it
//   □ Sections with only bullet lists and no prose — Section 1 must be prose
//   □ Missing file citations in Section 8 recipes
```

---

## FILE 3 — `browser/riafAgentService.ts` (CREATE)

```typescript
/*
 * browser/riafAgentService.ts
 * Browser-side service that triggers the RIAF agent run.
 *
 * This is intentionally thin — all the heavy lifting is done by the
 * existing agent orchestration in chatThreadService.ts.
 *
 * Compared to the gather-mode browser/riafService.ts:
 *   OLD: IPC proxy wrapping a custom electron-main service (~60 lines of glue)
 *   NEW: Direct calls to chatThreadService + settingsService (~80 lines total)
 *
 * No IPC. No channel. No custom progress events.
 * Progress is visible in the sidebar through the agent's natural plan view.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IChatThreadService } from './chatThreadService.js';
import { ITroveSettingsService } from '../common/troveSettingsService.js';
import { buildRiafAgentPrompt, } from '../common/riaf/riafPrompts.js';
import {
  DEFAULT_RIAF_CONFIG,
  IRiafAgentService,
  RiafConfig,
  RiafRunState,
} from '../common/riaf/riafTypes.js';

class RiafAgentService extends Disposable implements IRiafAgentService {
  readonly _serviceBrand: undefined;

  private _state: RiafRunState = { status: 'idle' };

  private readonly _onDidChangeState = this._register(new Emitter<RiafRunState>());
  readonly onDidChangeState: Event<RiafRunState> = this._onDidChangeState.event;

  constructor(
    @IChatThreadService private readonly _chatThreadService: IChatThreadService,
    @ITroveSettingsService private readonly _settingsService: ITroveSettingsService,
    @IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
  ) {
    super();

    // Listen for agent run completion on all threads. When we recognise our
    // RIAF thread ID, update state accordingly.
    this._register(
      this._chatThreadService.onDidFinishAgentRun(({ threadId, filesChanged }) => {
        if (this._state.status !== 'running' || this._state.threadId !== threadId) {
          return;
        }
        const outputFileName =
          (this._settingsService.state.globalSettings as any)._riafOutputFileName
          ?? DEFAULT_RIAF_CONFIG.outputFileName;

        const root = this._workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';
        const outputPath = `${root}/${outputFileName}`;

        // Check whether the agent actually wrote the file
        const wrote = filesChanged.some(f => f.endsWith(outputFileName));
        if (wrote) {
          this._setState({ status: 'done', threadId, outputPath });
        } else {
          this._setState({
            status: 'error',
            threadId,
            message: `Agent run finished but ${outputFileName} was not written. Check the thread for details.`,
          });
        }
      })
    );
  }

  get state(): RiafRunState {
    return this._state;
  }

  private _setState(state: RiafRunState): void {
    this._state = state;
    this._onDidChangeState.fire(state);
  }

  async startRun(configOverride?: Partial<RiafConfig>): Promise<void> {
    if (this._state.status === 'running') {
      return; // already running
    }

    const root = this._workspaceService.getWorkspace().folders[0]?.uri.fsPath;
    if (!root) {
      this._setState({ status: 'error', threadId: '', message: 'No workspace folder open.' });
      return;
    }

    const config: RiafConfig = { ...DEFAULT_RIAF_CONFIG, ...configOverride };

    // 1. Open a dedicated thread for this RIAF run
    this._chatThreadService.openNewThread();
    const threadId = this._chatThreadService.state.currentThreadId;

    // 2. Ensure agent mode is active
    //    (the user may have been in chat or gather mode)
    this._settingsService.setGlobalSettings({ chatMode: 'agent' });

    // Stash the output filename so the completion handler can find it
    (this._settingsService.state.globalSettings as any)._riafOutputFileName =
      config.outputFileName;

    // 3. Update our own state before the call so the UI renders immediately
    this._setState({ status: 'running', threadId });

    // 4. Send the agent prompt — this triggers the full agent loop
    //    The agent will plan, read files, search, and write TROVE_CONTEXT.md
    //    autonomously. We don't need to do anything else.
    await this._chatThreadService.addUserMessageAndStreamResponse({
      userMessage: buildRiafAgentPrompt(root, config),
      threadId,
    });
  }

  async abort(): Promise<void> {
    if (this._state.status !== 'running') return;
    await this._chatThreadService.abortRunning(this._state.threadId);
    this._setState({ status: 'idle' });
  }
}

registerSingleton(IRiafAgentService, RiafAgentService, InstantiationType.Delayed);
```

---

## FILE 4 — `browser/react/src/sidebar-tsx/ContextDocPanel.tsx` (CREATE)

```tsx
/*
 * ContextDocPanel.tsx
 * Sidebar panel that shows RIAF run state and lets users trigger generation.
 *
 * Compared to the gather-mode version, this component is dramatically simpler:
 *   OLD: Custom phase enum, custom progress bar, onRiafProgress event subscription,
 *        4 distinct render states (discovery/analyzing/synthesizing/writing).
 *   NEW: 3 states (idle/running/done-or-error). The agent's own plan and tool
 *        activity is visible inline in the chat thread — no custom progress
 *        indicator is needed here.
 *
 * The running state just shows a spinner + "Agent is analysing the repository..."
 * The actual step-by-step progress (get_dir_tree, read_file, etc.) is visible
 * in the thread itself via PlanView.tsx and ChatActivityUI.tsx.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useService } from '../util/services.jsx';
import { IRiafAgentService } from '../../../../riafAgentService.js';
import { IChatThreadService } from '../../../../chatThreadService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import type { RiafRunState } from '../../../../../common/riaf/riafTypes.js';

export function ContextDocPanel() {
  const riafService    = useService(IRiafAgentService);
  const threadService  = useService(IChatThreadService);
  const commandService = useService(ICommandService);

  const [state, setState] = useState<RiafRunState>(riafService.state);

  // Subscribe to state changes from the service
  useEffect(() => {
    const sub = riafService.onDidChangeState(setState);
    return () => sub.dispose();
  }, [riafService]);

  // When a run starts, switch the visible thread to the RIAF thread so the
  // user can see the agent's plan and tool activity live.
  useEffect(() => {
    if (state.status === 'running') {
      threadService.switchToThread(state.threadId);
    }
  }, [state, threadService]);

  const handleStart = useCallback(() => {
    riafService.startRun();
  }, [riafService]);

  const handleAbort = useCallback(() => {
    riafService.abort();
  }, [riafService]);

  const handleOpen = useCallback(() => {
    if (state.status !== 'done') return;
    commandService.executeCommand('vscode.open', state.outputPath);
  }, [state, commandService]);

  return (
    <div style={{
      padding: '10px 12px',
      borderBottom: '1px solid var(--vscode-editorGroup-border)',
    }}>

      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--vscode-descriptionForeground)',
        }}>
          Context Document
        </span>

        {/* Action buttons */}
        {state.status === 'idle' && (
          <button onClick={handleStart} style={btnStyle('primary')}>
            Analyse Repo
          </button>
        )}
        {state.status === 'running' && (
          <button onClick={handleAbort} style={btnStyle('danger')}>
            Stop
          </button>
        )}
        {(state.status === 'done' || state.status === 'error') && (
          <button onClick={handleStart} style={btnStyle('secondary')}>
            Re-analyse
          </button>
        )}
      </div>

      {/* Running state — minimal; progress detail is in the thread */}
      {state.status === 'running' && (
        <div style={{
          fontSize: 11,
          color: 'var(--vscode-descriptionForeground)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{ animation: 'spin 1s linear infinite' }}>⟳</span>
          Agent is analysing the repository…
        </div>
      )}

      {/* Done state */}
      {state.status === 'done' && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--vscode-terminal-ansiGreen)', marginBottom: 4 }}>
            ✓ TROVE_CONTEXT.md written
          </div>
          <button onClick={handleOpen} style={{
            ...btnStyle('link'),
            width: '100%',
            textAlign: 'left',
          }}>
            Open TROVE_CONTEXT.md →
          </button>
          <div style={{
            fontSize: 10,
            color: 'var(--vscode-descriptionForeground)',
            marginTop: 4,
            opacity: 0.7,
          }}>
            Tag in chat: @TROVE_CONTEXT.md
          </div>
        </div>
      )}

      {/* Error state */}
      {state.status === 'error' && (
        <div style={{ fontSize: 11, color: 'var(--vscode-errorForeground)', marginTop: 4 }}>
          ✗ {state.message}
        </div>
      )}

    </div>
  );
}

// ── Shared button style helper ─────────────────────────────────────────────────

function btnStyle(variant: 'primary' | 'secondary' | 'danger' | 'link'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    padding: '2px 8px',
    cursor: 'pointer',
    border: 'none',
    borderRadius: 3,
  };
  if (variant === 'primary') return {
    ...base,
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
  };
  if (variant === 'secondary') return {
    ...base,
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
  };
  if (variant === 'danger') return {
    ...base,
    background: 'transparent',
    color: 'var(--vscode-errorForeground)',
    border: '1px solid var(--vscode-errorForeground)',
  };
  // link
  return {
    ...base,
    background: 'transparent',
    color: 'var(--vscode-textLink-foreground)',
    border: '1px solid var(--vscode-textLink-foreground)',
  };
}
```

---

## FILE 5 — Modifications to `browser/trove.contribution.ts`

### Add imports

```typescript
import { IRiafAgentService } from './riafAgentService.js';
```

### Register the singleton (in the services block)

```typescript
// In the registerSingleton block alongside other browser services:
registerSingleton(IRiafAgentService, RiafAgentService, InstantiationType.Delayed);
```

> **Note:** `registerSingleton` is already called inside `riafAgentService.ts` via
> the module-level call at the bottom of the file. The import in contribution.ts
> is sufficient to pull that registration in — no additional call needed here.
> Just add the import.

### Register the keybinding command

```typescript
CommandsRegistry.registerCommand({
  id: 'trove.analyseRepository',
  handler: (accessor) => {
    const riafService = accessor.get(IRiafAgentService);
    riafService.startRun();
  },
});

KeybindingsRegistry.registerKeybindingRule({
  id: 'trove.analyseRepository',
  weight: KeybindingWeight.WorkbenchContrib,
  primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK,
  when: undefined,
});
```

---

## FILE 6 — Modifications to `SidebarChat.tsx`

Add `<ContextDocPanel />` above the chat message list:

```tsx
// Add import at top
import { ContextDocPanel } from './ContextDocPanel.jsx';

// Add in JSX, just above the chat thread / message list area:
<ContextDocPanel />
```

---

## How the Agent Orchestration Does the Old Pipeline's Work

This section maps each eliminated pipeline phase to what the agent does instead:

### Phase 1 (Discovery) → `get_dir_tree` + `ls_dir`

The old pipeline called `scanWorkspace()` in electron-main and filtered results.
The agent calls `get_dir_tree(workspaceRoot)` then `ls_dir()` on subdirectories.
Same information, no custom code.

### Phase 2 (Manifest parsing) → `read_file(package.json)`

The old pipeline called a dedicated manifest-parse LLM call to extract dep metadata.
The agent simply reads `package.json`, `tsconfig.json`, etc. as part of its normal
file-reading phase. The synthesis (writing the doc) naturally incorporates what it read.
No dedicated LLM call, no JSON parser.

### Phase 3 (Per-file micro-summaries) → `read_file` × N (parallel-batched)

**This was the most expensive part of the old design.**

Old: N separate LLM calls (one per file), each producing a structured
`FileMicroSummary` object that had to be parsed with `parseMicroSummaryResponse()`.
For 80 files at batches of 6: 14 API calls just for analysis.

New: The agent reads files turn by turn. `parallelReadToolBatch.ts` automatically
batches up to 5 reads per turn (1 primary + 4 discovered by the batch discovery LLM call).
`toolResultCompaction.ts` compacts old reads once they've been processed, keeping the
context budget stable. The agent naturally integrates what it reads into its understanding
across turns — no parsing required.

For 80 files the agent typically uses 10–15 turns reading them, not 14+ separate LLM
calls. And each "turn" is a full agent reasoning step where the model integrates
what it just read — far higher quality than a micro-summary prompt.

### Phase 4 (Synthesis) → Final agent turn writes `create_file_or_folder`

Old: A dedicated synthesis LLM call with a 6k–12k token input prompt assembled by
`buildSynthesisPrompt()`, with optional extended thinking.

New: The agent has been accumulating understanding across all its reading turns. When
it has enough context, it writes the file directly using `create_file_or_folder`. There is
no separate "synthesis call" — the writing turn IS the synthesis. The agent can still
use a reasoning/thinking-capable model if the user has one selected.

> **If you want a dedicated reasoning model for synthesis:** The agent prompt already
> instructs the agent to write only when it has "sufficient understanding". You can
> additionally wire a model override via `settingsService.setGlobalSettings` before
> calling `startRun()` — set the Chat model to a reasoning model for the duration
> of the RIAF run and restore it afterward.

### Phase 5 (File write) → `create_file_or_folder` tool

Identical outcome. The agent writes the file using its built-in tool. The
`AgentDeliveryService` tracks the file in `filesChanged`, and `onDidFinishAgentRun`
fires with that list — which is how `RiafAgentService` detects completion.

---

## What the Agent's Plan Looks Like in the Sidebar

When the run starts, `generateAgentPlan()` fires before the first tool call and
produces something like:

```
● Get directory structure and identify key files        [done]
● Read entry points and service definitions             [done]
● Search for IPC channels and module wiring patterns   [running]
● Read remaining significant files                     [pending]
● Write TROVE_CONTEXT.md to workspace root             [pending]
```

This is rendered by the existing `PlanView.tsx` — the user sees live progress
without any custom progress-bar code in `ContextDocPanel.tsx`.

---

## TROVE_CONTEXT.md — What the Output Looks Like (unchanged)

The output format is identical to the original guide. The same 12 sections,
the same emphasis on Section 4 (Module Wiring) and Section 8 (Cookbook).

The key quality difference with agent mode: because the agent reads files
**adaptively** (it reads what the previous read reveals it should read), the
wiring and call-chain information in Section 4 is significantly more accurate
than the gather-mode pipeline's micro-summary approach, which could only
extract what was visible in each file in isolation.

Example of Section 4 agent-mode output quality:

```
### Chat Thread → LLM Dispatch

Triggered by: SidebarChat.tsx handleSubmit()
  → IChatThreadService.addUserMessageAndStreamResponse({ userMessage, threadId })
  → ChatThreadService._addUserMessageAndStreamResponse()  [chatThreadService.ts:1578]
  → IConvertToLLMMessageService.prepareLLMChatMessages()
  → ILLMMessageService.sendLLMMessage({ messagesType:'chatMessages', ... })
  → LLMMessageChannel.ts:call('sendLLMMessage')           [IPC boundary]
  → sendLLMMessage.impl.ts:sendAnthropicMessage()
    side-effects: onText streaming → _streamState[threadId].llmInfo update
                  onFinalMessage  → tool call parsing → _runToolLoop()
                  onError         → _setStreamState error + retry logic
```

---

## Prompt Tuning Notes

All quality improvement levers are still in `riafPrompts.ts`. The single
`buildRiafAgentPrompt()` function is the only thing to tune.

| Goal | Change to make |
|---|---|
| More detailed wiring (Sec 4) | Add: "For every service, trace its full call chain end-to-end including IPC boundaries" |
| Better cookbook (Sec 8) | Add: "Every recipe MUST cite the existing file it was derived from" |
| Shorter output | Add per-section word caps: "[max 150 words]" |
| Force full coverage | Add: "You MUST read every file listed in get_dir_tree before writing" |
| Dedicated reasoning model | Override Chat model in `settingsService` before `startRun()` |
| Incremental re-run | Add: "TROVE_CONTEXT.md already exists at {outputPath}. Update only the sections that have changed based on new files you find." |

---

## Testing Checklist

Run against the FMS logistics repo for end-to-end validation:

### Trigger & UI
- [ ] `Ctrl+Shift+K` triggers a new agent thread in the sidebar
- [ ] ContextDocPanel shows "Agent is analysing the repository…" immediately
- [ ] The sidebar switches to the RIAF thread automatically
- [ ] The agent's plan appears in the thread within the first 5 seconds
- [ ] Plan items tick to `done` as tools execute
- [ ] "Stop" button aborts the run and resets panel to idle
- [ ] After completion, "Open TROVE_CONTEXT.md" button appears

### Output quality
- [ ] `TROVE_CONTEXT.md` appears in the workspace root
- [ ] Document contains all 12 sections in the correct order
- [ ] Section 4 contains actual method names, not just file names
- [ ] Section 8 recipes reference specific existing files as examples
- [ ] No generic boilerplate (run: `grep -i "comprehensive\|robust\|scalable" TROVE_CONTEXT.md`)

### Agent orchestration
- [ ] Agent reads ≥ 15 files before writing (check tool log in thread)
- [ ] Reads are visibly batched (multiple `read_file` calls appear together)
- [ ] Context was not truncated mid-run (check for contextWasTrimmed in thread state)
- [ ] `create_file_or_folder` appears as the final tool call in the thread

### Context usage
- [ ] `@TROVE_CONTEXT.md` in a new chat injects full file content as context
- [ ] A second run on an unchanged repo completes faster
  (agent finds the existing doc and can use it for faster orientation)

---

## Architecture Invariants (carry forward unchanged)

1. **`common/riaf/`** — types and prompts only, zero Node.js imports
2. **`browser/`** — service layer + React only, no direct file I/O
3. **`electron-main/`** — receives **zero new files** for this feature
4. All LLM calls go through `sendLLMMessage.impl.ts` (agent loop handles this)
5. All file writes go through the `create_file_or_folder` tool (agent loop handles this)
6. Progress is surfaced through existing sidebar components (PlanView + ChatActivityUI)
