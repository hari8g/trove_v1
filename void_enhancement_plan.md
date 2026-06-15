# Void Editor — Enhancement Implementation Plan
## Repository Intelligence · Extended Tool Registry · Semantic Checkpointing

> **Governing Constraint:** Every addition is purely additive. No existing Void service, type, or component is removed or semantically altered. All new services follow the exact singleton registration pattern Void already uses. All new files are placed in the correct process layer as dictated by the Electron + VS Code contribution architecture.

---

## 0. Void Architecture Primer (Required Reading Before Any Code)

### 0.1 The Three-Layer Rule

All Void-specific code lives under one root:

```
src/vs/workbench/contrib/void/
├── common/          # process-agnostic: types, prompt strings, constants only
├── browser/         # renderer process: services, React UI, IPC proxies
│   └── react/src/   # React 19 component bundles (scoped Tailwind)
└── electron-main/   # main process: node_modules, file I/O, LLM calls, SQLite
```

The **hard rule** the VS Code architecture enforces:

| Layer | Can import node_modules? | Can use `window`? | Lives on |
|-------|--------------------------|-------------------|----------|
| `common/` | ❌ | ❌ | Either |
| `browser/` | ❌ (except bundled React) | ✅ | Renderer |
| `electron-main/` | ✅ | ❌ | Main |

**Consequence for our work:** SQLite, `better-sqlite3`, file-system crawling, tree-sitter parsing, and vector embedding all go in `electron-main/`. The browser talks to them exclusively via VS Code IPC channels.

### 0.2 The Service Registration Pattern

Every Void singleton is registered in `browser/void.contribution.ts` (browser services) or in the electron-main entry via `registerMainProcessService`. Example from the existing codebase:

```typescript
// common/: declare the interface + service identifier
export const IMyService = createDecorator<IMyService>('myService');
export interface IMyService { /* ... */ }

// browser/ (proxy) or electron-main/ (impl):
registerSingleton(IMyService, MyServiceImpl, InstantiationType.Eager);
```

New services must follow this pattern exactly.

### 0.3 The IPC Channel Pattern

Void uses a dedicated channel for each main-process service that the browser needs. Existing example: `void-channel-llmMessage`. The pattern:

```typescript
// common/: define the channel name as a constant
export const REPO_INTEL_CHANNEL = 'void-channel-repoIntelligence';

// electron-main/: register the service on the channel
mainProcessService.registerChannel(REPO_INTEL_CHANNEL, new RepoIntelligenceChannel(serviceImpl));

// browser/: create a proxy client
const client = new RepoIntelligenceChannelClient(ipcService.getChannel(REPO_INTEL_CHANNEL));
```

### 0.4 Existing Services We Must Not Break

| Service | File | What it does |
|---------|------|--------------|
| `IChatThreadService` | `browser/chatThreadService.ts` | Orchestrates agent loop, checkpoints, tool execution |
| `IToolsService` | `browser/toolsService.ts` | validate → execute → stringify for built-in tools |
| `ITerminalToolService` | `browser/terminalToolService.ts` | Persistent + temporary terminal management |
| `ILLMMessageService` | `browser/llmMessage/` (proxy) | IPC bridge to main-process LLM dispatcher |
| `IEditCodeService` | `browser/editCodeService.ts` | DiffZones, fast/slow Apply, file snapshots |
| `IVoidSettingsService` | `browser/voidSettingsService.ts` | All provider + model + global settings |
| `IMCPService` | `browser/mcp/` (proxy) | MCP tool execution bridge |

### 0.5 Existing Tool Inventory (Baseline)

**Context/Read tools** (approval: none):
`read_file`, `ls_dir`, `get_dir_tree`, `search_pathnames_only`, `search_for_files`, `search_in_file`, `read_lint_errors`

**Edit tools** (approval: `'edits'`):
`create_file_or_folder`, `delete_file_or_folder`, `edit_file`, `rewrite_file`

**Terminal tools** (approval: `'terminal'`):
`run_command`, `open_persistent_terminal`, `run_persistent_command`, `kill_persistent_terminal`

**Chat modes:**
- `normal` → no tools
- `gather` → read-only tools
- `agent` → all tools + all MCP tools

### 0.6 Existing Checkpoint Model (Baseline)

```typescript
// chatThreadServiceTypes.ts (existing)
type CheckpointEntry = {
  role: 'checkpoint';
  type: 'user_edit' | 'tool_edit';
  voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot };
  userModifications?: { voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot } };
}
```

Stored inline in the thread message array. Time-travel via `jumpToCheckpointBeforeMessageIdx()`. Limitation: captures only file text + diff state. No semantic context, no execution plan, no git state.

---

## 1. Enhancement 1 — Repository Intelligence Layer

### 1.1 Goal

When the workspace opens, the agent already knows the project's language stack, framework, build commands, architecture, and purpose — without reading any files at query time. This information is cached in a local SQLite database and injected as the first block of every agent system prompt.

### 1.2 New File Tree

```
src/vs/workbench/contrib/void/
├── common/
│   └── repoIntelligenceTypes.ts          [NEW] shared types + channel constant
├── browser/
│   └── repoIntelligenceService.ts         [NEW] browser-side proxy + public interface
└── electron-main/
    └── repoIntelligence/
        ├── repoIntelligenceService.impl.ts [NEW] main process implementation
        ├── repoIntelligenceDb.ts           [NEW] SQLite schema + query helpers
        ├── workspaceScanner.ts             [NEW] file crawl + language detection
        ├── commandDetector.ts             [NEW] build/test/lint command discovery
        └── repoIntelligenceChannel.ts     [NEW] IPC channel wrapper
```

**Minimal modifications to existing files:**
- `browser/void.contribution.ts` — add one `registerSingleton` line
- `electron-main/void.contribution.ts` — register main-process service on IPC channel
- `common/prompt/prompts.ts` — add one injection call at the top of `getSystemPrompt()`

### 1.3 SQLite Schema (`repoIntelligenceDb.ts`)

SQLite runs in `electron-main/` only. Library: `better-sqlite3` (already available in Electron's Node context).

```sql
-- Table 1: one row per workspace root
CREATE TABLE IF NOT EXISTS workspace_profiles (
  workspace_hash    TEXT PRIMARY KEY,   -- sha256 of the absolute workspace root path
  workspace_root    TEXT NOT NULL,
  last_scanned_at   INTEGER NOT NULL,   -- unix epoch ms
  language_stack    TEXT NOT NULL,      -- JSON: string[]
  frameworks        TEXT NOT NULL,      -- JSON: {name, version, confidence}[]
  package_managers  TEXT NOT NULL,      -- JSON: string[]
  build_commands    TEXT NOT NULL,      -- JSON: CommandEntry[]
  test_commands     TEXT NOT NULL,      -- JSON: CommandEntry[]
  lint_commands     TEXT NOT NULL,      -- JSON: CommandEntry[]
  typecheck_commands TEXT NOT NULL,     -- JSON: CommandEntry[]
  project_purpose   TEXT,              -- LLM-generated, nullable until generated
  architecture_summary TEXT,           -- LLM-generated, nullable
  file_count        INTEGER,
  total_loc         INTEGER,
  stale             INTEGER DEFAULT 0  -- 1 = needs rescan
);

-- Table 2: per-file metadata cache (for fast symbol lookup)
CREATE TABLE IF NOT EXISTS file_metadata (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,        -- relative to workspace root
  language        TEXT,
  last_modified   INTEGER NOT NULL,     -- mtime ms
  size_bytes      INTEGER,
  PRIMARY KEY (workspace_hash, file_path),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_workspace ON file_metadata(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_file_metadata_language ON file_metadata(workspace_hash, language);
```

The database file lives at `{globalStoragePath}/void-repo-intelligence.db`. `IEnvironmentService` in electron-main provides `globalStoragePath`.

### 1.4 Workspace Scanner (`workspaceScanner.ts`)

Runs entirely in `electron-main/` using Node.js `fs` APIs. No node_modules needed beyond built-ins.

**Algorithm:**

```
scan(workspaceRoot: string): RawScanResult
  1. Walk directory tree (BFS, skip: node_modules, .git, dist, build, out, __pycache__, .venv)
     - Max depth: 8 levels
     - Max files: 50,000
     - Collect: {relativePath, ext, mtime, sizeBytes}
  2. Language detection: map ext → language using a static 200-entry table
     - Count files per language → top 5 by file count
  3. Framework detection: read and parse these files if present:
     - package.json → dependencies/devDependencies → frameworks table (React, Next, Vue, etc.)
     - pyproject.toml, requirements.txt → Python frameworks (FastAPI, Django, Flask)
     - Cargo.toml → Rust crates
     - go.mod → Go modules
     - pom.xml, build.gradle → Java frameworks
     - composer.json → PHP frameworks
  4. Return: { languages, frameworks, packageManagers, fileMeta[], totalLoc }
```

### 1.5 Command Detector (`commandDetector.ts`)

Reads and parses project config files to discover actionable commands. Uses `JSON.parse` and regex. No LLM needed.

**Sources inspected (in priority order):**

```typescript
type CommandEntry = {
  command: string;           // e.g. "npm run build"
  purpose: 'build' | 'test' | 'lint' | 'typecheck' | 'start' | 'format';
  confidence: 'high' | 'medium' | 'low';
  source: string;            // e.g. "package.json#scripts.build"
}
```

Detection matrix:

| File | Commands extracted |
|------|-------------------|
| `package.json` | All `scripts.*` entries, classify by name heuristic |
| `Makefile` | `.PHONY` targets |
| `pyproject.toml` / `setup.cfg` | `[tool.pytest.ini_options]`, `[tool.ruff]` |
| `.github/workflows/*.yml` | `run:` steps in CI jobs |
| `.vscode/tasks.json` | VS Code task definitions |
| `justfile` | `just` recipe targets |
| `Taskfile.yml` | Taskfile targets |

### 1.6 LLM Summary Generation

After scanning, two LLM calls are made from `electron-main/` using the **existing** `sendLLMMessage` infrastructure:

```typescript
// Both calls go through the existing ILLMMessageService channel
// (void-channel-llmMessage) — no new LLM channel needed

const architectureSummary = await callLLMForSummary({
  model: 'fast',  // resolved via IVoidSettingsService
  systemPrompt: ARCH_SUMMARY_SYSTEM_PROMPT,
  userContent: buildScanContext(scanResult)  // ~2000 tokens of scan data
});

const purposeSummary = await callLLMForSummary({
  model: 'fast',
  systemPrompt: PURPOSE_SUMMARY_SYSTEM_PROMPT,
  userContent: buildPurposeContext(scanResult)
});
```

Both summaries are written to `workspace_profiles` and never regenerated unless the profile is explicitly refreshed. Cost: two calls, one time per workspace.

### 1.7 IPC Channel (`repoIntelligenceChannel.ts` + `common/repoIntelligenceTypes.ts`)

```typescript
// common/repoIntelligenceTypes.ts

export const REPO_INTEL_CHANNEL = 'void-channel-repoIntelligence';

export interface WorkspaceProfile {
  workspaceRoot: string;
  lastScannedAt: number;
  languageStack: string[];
  frameworks: FrameworkEntry[];
  packageManagers: string[];
  buildCommands: CommandEntry[];
  testCommands: CommandEntry[];
  lintCommands: CommandEntry[];
  typecheckCommands: CommandEntry[];
  projectPurpose: string | null;
  architectureSummary: string | null;
  fileCount: number;
  totalLoc: number;
  isStale: boolean;
}

export interface IRepoIntelligenceService {
  getProfile(workspaceRoot: string): Promise<WorkspaceProfile | null>;
  refreshProfile(workspaceRoot: string): Promise<WorkspaceProfile>;
  getProfileSync(): WorkspaceProfile | null;   // cached in browser after first fetch
}
```

The channel exposes three methods: `getProfile`, `refreshProfile`, `getProfileSync`. The IPC transport uses VS Code's `ProxyChannel.fromService` / `ProxyChannel.toService` helpers — exactly as `sendLLMMessageService` does.

### 1.8 Browser Proxy Service (`browser/repoIntelligenceService.ts`)

```typescript
// Registered as: registerSingleton(IRepoIntelligenceService, RepoIntelligenceService, ...)
// Constructor injects: IMainProcessService (to open the IPC channel)
//                      IWorkspaceContextService (to get the workspace root)

class RepoIntelligenceService implements IRepoIntelligenceService {
  private _cachedProfile: WorkspaceProfile | null = null;

  constructor(
    @IMainProcessService private readonly _mainProcessService: IMainProcessService,
    @IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
  ) {
    // On workspace open: trigger background scan/cache population
    this._initProfile();
  }

  private async _initProfile() {
    const root = this._getWorkspaceRoot();
    if (!root) return;
    const channel = this._mainProcessService.getChannel(REPO_INTEL_CHANNEL);
    const proxy = ProxyChannel.toService<IRepoIntelligenceService>(channel);
    this._cachedProfile = await proxy.getProfile(root);
  }

  getProfileSync(): WorkspaceProfile | null {
    return this._cachedProfile;
  }
}
```

### 1.9 System Prompt Injection

The **only** modification to `common/prompt/prompts.ts` is a new function `buildRepoContextBlock()` called at the top of the existing `getSystemPrompt()` function:

```typescript
// In common/prompt/prompts.ts — ADD only, don't remove anything

export function buildRepoContextBlock(profile: WorkspaceProfile | null): string {
  if (!profile) return '';
  return `
<repository_context>
Project: ${profile.workspaceRoot.split('/').at(-1)}
Languages: ${profile.languageStack.join(', ')}
Frameworks: ${profile.frameworks.map(f => f.name).join(', ')}
Purpose: ${profile.projectPurpose ?? 'unknown'}
Architecture: ${profile.architectureSummary ?? 'unknown'}
Build: ${profile.buildCommands[0]?.command ?? 'none detected'}
Test: ${profile.testCommands[0]?.command ?? 'none detected'}
Lint: ${profile.lintCommands[0]?.command ?? 'none detected'}
</repository_context>
`.trim();
}
```

In `chatThreadService.ts`, pass the profile to system prompt construction:

```typescript
// In ChatThreadService._runChatAgent() — single line addition
const repoCtx = this._repoIntelligenceService.getProfileSync();
const systemPrompt = getSystemPrompt(thread.chatMode, tools, repoCtx);
//                                                           ^ new param, optional with default null
```

### 1.10 Workspace Change Watcher

When the user adds a new workspace folder, the profile is automatically invalidated:

```typescript
// In browser/repoIntelligenceService.ts constructor:
this._register(
  this._workspaceContextService.onDidChangeWorkspaceFolders(async (e) => {
    if (e.added.length > 0) {
      await this._initProfile();   // re-fetch
    }
  })
);
```

The profile also auto-expires after 24 hours (checked on next `_initProfile()` using `lastScannedAt`).

---

## 2. Enhancement 2 — Intent Classifier + Extended Tool Registry

### 2.1 Goal

Before the agent loop starts, classify the user's message into a structured intent. Use that intent to: select the optimal tool subset, set execution risk level, and enforce sandbox policy. Expand the tool surface with 12 new tools covering git operations, semantic code search, build/test/lint runners, and workspace navigation.

### 2.2 New File Tree

```
src/vs/workbench/contrib/void/
├── common/
│   ├── intentClassifierTypes.ts       [NEW] intent enum + ClassifiedIntent type
│   └── toolRegistry.ts                [NEW] centralized tool metadata table
├── browser/
│   ├── intentClassifierService.ts     [NEW] LLM-powered intent classification
│   ├── contextPackService.ts          [NEW] context pack assembly per intent
│   └── toolsService.ts               [EXTEND] add 12 new tool implementations
└── electron-main/
    └── gitToolService.ts              [NEW] git-command execution (needs Node.js child_process)
```

**Minimal modifications to existing files:**
- `common/toolsServiceTypes.ts` — add 12 new entries to `BuiltinToolName` union
- `common/prompt/prompts.ts` — add 12 new tool definitions to `builtinTools` array
- `browser/chatThreadService.ts` — call intent classifier before `_runChatAgent()`

### 2.3 Intent Taxonomy (`intentClassifierTypes.ts`)

```typescript
export type IntentType =
  | 'bug_fix'          // "fix the TypeError in line 42"
  | 'feature_add'      // "add dark mode support"
  | 'refactor'         // "extract this function into a service"
  | 'test_write'       // "write tests for the AuthService"
  | 'explain'          // "explain how the context pack works"
  | 'build_run'        // "run the build and fix any errors"
  | 'repo_query'       // "which files import the UserService?"
  | 'setup'            // "set up the dev environment for this project"
  | 'review'           // "review this PR diff for issues"
  | 'unknown';         // fallback

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ClassifiedIntent {
  type: IntentType;
  risk: RiskLevel;
  requiresFileWrite: boolean;
  requiresTerminal: boolean;
  requiresUserApproval: boolean;
  confidenceScore: number;           // 0.0 – 1.0
  assumptions: string[];             // stated before execution
  suggestedToolSubset: string[];     // tool names the agent should prefer
}
```

### 2.4 Intent Classifier Service (`browser/intentClassifierService.ts`)

This is a browser-side service that makes **one cheap LLM call** (via the existing `ILLMMessageService` IPC bridge) to classify the intent before the agent loop.

```typescript
// Temperature: 0.0   Model: fast/cheap (haiku-class)
// Token budget: 300 tokens output
// Output format: strict JSON matching ClassifiedIntent schema

const INTENT_SYSTEM_PROMPT = `
You are an intent classifier for an AI code editor.
Classify the user message into exactly one intent type and return JSON only.
Schema: { type, risk, requiresFileWrite, requiresTerminal, requiresUserApproval,
          confidenceScore, assumptions, suggestedToolSubset }
Available intent types: bug_fix | feature_add | refactor | test_write | explain | 
                         build_run | repo_query | setup | review | unknown
Available tools: [list of all registered tool names]
Return ONLY valid JSON, no markdown.
`.trim();
```

The classified intent is stored on the `ThreadStreamState` so the UI can display the risk badge before the plan is shown. If the LLM call fails or times out (>2s), the service returns a default `unknown` intent and the agent proceeds normally — no blocking.

**Integration with `chatThreadService.ts`:**

```typescript
// In ChatThreadService.addUserMessageAndStreamResponse() — ADD these lines before _runChatAgent()
const intent = await this._intentClassifierService.classify(userMessage, repoCtx);
this._setStreamState(threadId, { isRunning: 'classifying', intent });
// intent is passed into _runChatAgent() to drive tool selection
```

### 2.5 Centralized Tool Registry (`common/toolRegistry.ts`)

This is a **new** centralized registry that augments (not replaces) the existing `builtinTools` array in `prompts.ts`. The registry holds metadata that cannot be expressed in the existing prompt-definition format:

```typescript
export type ToolCategory =
  | 'read_context'    // read_file, ls_dir, get_dir_tree, search_*
  | 'write_file'      // edit_file, rewrite_file, create_file_or_folder
  | 'delete'          // delete_file_or_folder
  | 'terminal_safe'   // run_command in sandbox
  | 'terminal_danger' // run_command outside sandbox
  | 'git_read'        // git status, diff, log — read-only
  | 'git_write'       // git branch, commit draft
  | 'semantic_search' // vector-similarity search over indexed codebase
  | 'build_run'       // build, test, lint, typecheck runners
  | 'repo_query';     // architecture/dependency queries

export interface ToolRegistryEntry {
  name: string;                     // must match BuiltinToolName
  category: ToolCategory;
  riskLevel: 'read' | 'write' | 'execute' | 'dangerous';
  requiresSandbox: boolean;         // true = must have sandbox context
  approvalType: ToolApprovalType | null;   // null = auto-approve
  intentAffinities: IntentType[];  // intents where this tool is most useful
  costEstimate: 'free' | 'cheap' | 'expensive';  // token cost hint
  description: string;
}

// The registry is a Map keyed by tool name for O(1) lookup
export const TOOL_REGISTRY: Map<string, ToolRegistryEntry> = new Map([
  // --- EXISTING TOOLS (re-registered with richer metadata) ---
  ['read_file',          { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['bug_fix','refactor','explain','test_write','review'], costEstimate: 'cheap', description: 'Read file content with pagination' }],
  ['ls_dir',             { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['repo_query','setup'], costEstimate: 'free', description: 'List directory contents' }],
  ['get_dir_tree',       { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['repo_query','setup','review'], costEstimate: 'free', description: 'Recursive directory tree' }],
  ['search_pathnames_only', { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['repo_query','bug_fix'], costEstimate: 'free', description: 'Search file paths by name pattern' }],
  ['search_for_files',   { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['bug_fix','refactor'], costEstimate: 'cheap', description: 'Search file contents by text' }],
  ['search_in_file',     { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['bug_fix','refactor'], costEstimate: 'cheap', description: 'Search within a specific file' }],
  ['read_lint_errors',   { category: 'read_context', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['bug_fix','build_run'], costEstimate: 'free', description: 'Read current lint diagnostics' }],
  ['edit_file',          { category: 'write_file', riskLevel: 'write', requiresSandbox: true, approvalType: 'edits', intentAffinities: ['bug_fix','feature_add','refactor','test_write'], costEstimate: 'expensive', description: 'Apply search/replace edits to file' }],
  ['rewrite_file',       { category: 'write_file', riskLevel: 'write', requiresSandbox: true, approvalType: 'edits', intentAffinities: ['refactor','feature_add'], costEstimate: 'expensive', description: 'Rewrite entire file content' }],
  ['create_file_or_folder',{ category: 'write_file', riskLevel: 'write', requiresSandbox: true, approvalType: 'edits', intentAffinities: ['feature_add','setup'], costEstimate: 'cheap', description: 'Create new file or directory' }],
  ['delete_file_or_folder',{ category: 'delete', riskLevel: 'dangerous', requiresSandbox: false, approvalType: 'edits', intentAffinities: ['refactor'], costEstimate: 'free', description: 'Delete file or directory — requires approval' }],
  ['run_command',        { category: 'terminal_safe', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['build_run','setup'], costEstimate: 'free', description: 'Run shell command in temporary terminal' }],
  ['open_persistent_terminal',{ category: 'terminal_safe', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['build_run','setup'], costEstimate: 'free', description: 'Open named persistent terminal' }],
  ['run_persistent_command',{ category: 'terminal_safe', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['build_run'], costEstimate: 'free', description: 'Run command in named persistent terminal' }],
  ['kill_persistent_terminal',{ category: 'terminal_safe', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['build_run'], costEstimate: 'free', description: 'Kill persistent terminal' }],

  // --- NEW TOOLS ---
  ['get_git_status',     { category: 'git_read', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['bug_fix','review','refactor'], costEstimate: 'free', description: 'Get current git status (staged, unstaged, untracked files)' }],
  ['get_git_diff',       { category: 'git_read', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['review','bug_fix'], costEstimate: 'cheap', description: 'Get git diff for staged or unstaged changes' }],
  ['get_git_log',        { category: 'git_read', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['review','bug_fix'], costEstimate: 'cheap', description: 'Get recent git commit history with messages' }],
  ['create_git_branch',  { category: 'git_write', riskLevel: 'dangerous', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['feature_add','bug_fix'], costEstimate: 'free', description: 'Create and switch to a new git branch' }],
  ['search_symbols',     { category: 'semantic_search', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['repo_query','refactor','bug_fix','explain'], costEstimate: 'cheap', description: 'Search code symbols (functions, classes, interfaces) by name or description' }],
  ['get_file_outline',   { category: 'semantic_search', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['explain','review','refactor'], costEstimate: 'free', description: 'Get structural outline (symbols + line numbers) for a file' }],
  ['get_dependency_graph',{ category: 'repo_query', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['refactor','explain','repo_query'], costEstimate: 'cheap', description: 'Get import/dependency graph for a file or symbol' }],
  ['run_build',          { category: 'build_run', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['build_run','bug_fix'], costEstimate: 'free', description: 'Run the project build command from the workspace profile' }],
  ['run_tests',          { category: 'build_run', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['test_write','bug_fix','build_run'], costEstimate: 'free', description: 'Run the project test command (full suite or filtered)' }],
  ['run_lint',           { category: 'build_run', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['bug_fix','build_run'], costEstimate: 'free', description: 'Run the project lint command' }],
  ['run_typecheck',      { category: 'build_run', riskLevel: 'execute', requiresSandbox: false, approvalType: 'terminal', intentAffinities: ['bug_fix','build_run'], costEstimate: 'free', description: 'Run TypeScript or language type-checker' }],
  ['semantic_search_code',{ category: 'semantic_search', riskLevel: 'read', requiresSandbox: false, approvalType: null, intentAffinities: ['repo_query','explain','bug_fix','refactor'], costEstimate: 'cheap', description: 'Semantic similarity search over indexed codebase using embeddings' }],
]);
```

### 2.6 Tool Selection by Intent

The intent classifier's `suggestedToolSubset` field tells `_runChatAgent` which tools to advertise to the LLM for this particular task. This does **not** prevent other tools from being called — it's a hint to the system prompt, not a hard restriction:

```typescript
// In common/prompt/prompts.ts — new function, additive
export function getIntentAwareToolSubset(
  intent: ClassifiedIntent,
  allTools: BuiltinToolName[]
): BuiltinToolName[] {
  if (intent.type === 'unknown') return allTools;   // no filtering on unknown intent
  
  const registry = TOOL_REGISTRY;
  return allTools.filter(toolName => {
    const entry = registry.get(toolName);
    if (!entry) return true;  // unknown tool: include it
    // Include if tool has affinity for this intent, OR if it's a read tool (always useful)
    return entry.riskLevel === 'read' || entry.intentAffinities.includes(intent.type);
  });
}
```

### 2.7 New Tool Implementations

#### 2.7.1 Git Tools (`electron-main/gitToolService.ts`)

Git commands run via `child_process.execFile('git', [...], { cwd: workspaceRoot })` in electron-main. The browser calls them through a new IPC channel `void-channel-gitTools`.

```typescript
// All three read commands map to: git {subcommand} --format=... | head -N
// Output is returned as plain text, stringified for LLM consumption

async getGitStatus(workspaceRoot: string): Promise<string>
  → execFile('git', ['status', '--short', '--porcelain'], { cwd: workspaceRoot })
  → returns: "M  src/foo.ts\n?? src/bar.ts\n..."

async getGitDiff(workspaceRoot: string, staged: boolean): Promise<string>
  → execFile('git', staged ? ['diff', '--cached'] : ['diff'], { cwd: workspaceRoot })
  → truncated to MAX_DIFF_CHARS (50,000 chars)

async getGitLog(workspaceRoot: string, n: number = 20): Promise<string>
  → execFile('git', ['log', '--oneline', `-${n}`], { cwd: workspaceRoot })
```

#### 2.7.2 Build/Test/Lint Runners (`browser/toolsService.ts` extension)

These tools read the cached workspace profile to get the right command, then delegate to `ITerminalToolService.runTemporaryCommand()` (which already exists):

```typescript
// In toolsService.ts — new implementations added in the existing case-switch pattern

case 'run_build':
  const buildCmd = repoProfile?.buildCommands[0]?.command;
  if (!buildCmd) throw new Error('No build command found in workspace profile');
  return this._terminalToolService.runTemporaryCommand(buildCmd);

case 'run_tests':
  const filter = params.filter as string | undefined;
  const testCmd = repoProfile?.testCommands[0]?.command;
  const fullCmd = filter ? `${testCmd} ${filter}` : testCmd;
  return this._terminalToolService.runTemporaryCommand(fullCmd);
```

#### 2.7.3 Symbol Search (`browser/toolsService.ts` extension)

`search_symbols` and `get_file_outline` use VS Code's built-in `ILanguageFeaturesService` which is already available in the browser process:

```typescript
case 'search_symbols':
  // Use VS Code's built-in workspace symbol provider (already available)
  const symbols = await this._languageFeaturesService.workspaceSymbolProvider
    .provideWorkspaceSymbols(params.query, CancellationToken.None);
  return { symbols: symbols.slice(0, 50) };   // top 50 matches

case 'get_file_outline':
  const model = this._modelService.getModel(URI.file(params.filePath));
  const outline = await this._outlineModelService.getOrCreate(model, CancellationToken.None);
  return { outline: outline.asListOfDocumentSymbols() };
```

`semantic_search_code` is described in Enhancement 3 (it requires the vector index built there).

### 2.8 Context Pack Assembly (`browser/contextPackService.ts`)

Before the agent loop, assemble a curated context pack that injects only the most relevant content:

```typescript
export interface ContextPack {
  repoContext: string;           // from RepoIntelligenceService
  semanticFiles: FileSnippet[];  // top-K files from semantic search
  symbolContext: string[];       // relevant symbol definitions
  dependencyNeighbors: string[]; // files that import/are-imported-by mentioned files
  domainContext: string | null;  // reserved for domain-specific RAG (Phase 10-equivalent)
}

// Called once before _runChatAgent(), stored in ThreadStreamState
async assembleContextPack(
  userMessage: string,
  intent: ClassifiedIntent,
  repoProfile: WorkspaceProfile | null
): Promise<ContextPack>
```

The context pack is included in the system prompt for the duration of that agent session. It is never modified mid-session (prevents context drift). Total pack size is capped at 8,000 tokens.

### 2.9 Risk Policy Enforcement in Tool Execution

The existing `_runToolCall()` in `chatThreadService.ts` already checks `approvalType`. We augment it to also consult the registry for `requiresSandbox`:

```typescript
// In chatThreadService.ts _runToolCall() — ADD after existing validation, before existing approval check
const registryEntry = TOOL_REGISTRY.get(toolName);
if (registryEntry?.requiresSandbox && !this._hasSandboxContext(threadId)) {
  // Surface a clear error rather than silently proceeding
  this._addErrorToThread(threadId, 
    `Tool "${toolName}" requires a sandbox context. Agent must create a sandbox branch first.`
  );
  return { awaitingUserApproval: false, sandboxRequired: true };
}
```

This is **additive** — `requiresSandbox` defaults to `false` for all existing tools, so their behavior is unchanged.

---

## 3. Enhancement 3 — Semantic Checkpointing + Indexing

### 3.1 Goal

Upgrade the checkpoint system from "file snapshots" to "semantic execution snapshots". Each checkpoint carries the intent, the plan state, changed-file diffs, git ref, and a named label. Add a semantic vector index over the codebase (SQLite-vec or LanceDB) to power fast embedding-based file retrieval for context pack assembly.

### 3.2 New File Tree

```
src/vs/workbench/contrib/void/
├── common/
│   ├── semanticCheckpointTypes.ts         [NEW] extended checkpoint type
│   └── semanticIndexTypes.ts              [NEW] embedding + search types
├── browser/
│   ├── semanticCheckpointService.ts       [NEW] enhanced checkpoint lifecycle
│   └── react/src/sidebar-tsx/
│       └── CheckpointTimeline.tsx         [NEW] visual checkpoint timeline
└── electron-main/
    └── semanticIndex/
        ├── semanticIndexService.impl.ts   [NEW] main-process embedding + SQLite-vec
        ├── semanticIndexDb.ts             [NEW] SQLite-vec schema + helpers
        ├── embeddingProvider.ts           [NEW] local embedding (all-MiniLM-L6-v2)
        └── semanticIndexChannel.ts        [NEW] IPC channel
```

**Minimal modifications to existing files:**
- `common/chatThreadServiceTypes.ts` — extend `CheckpointEntry` via intersection type (backward-compatible)
- `browser/chatThreadService.ts` — call new `ISemanticCheckpointService` alongside existing checkpoint code
- `browser/react/src/sidebar-tsx/SidebarChat.tsx` — render `CheckpointTimeline` alongside existing checkpoint rows

### 3.3 Extended Checkpoint Type (`common/semanticCheckpointTypes.ts`)

The existing `CheckpointEntry` is kept **completely unchanged**. We extend it via an intersection type:

```typescript
// common/semanticCheckpointTypes.ts

import type { CheckpointEntry } from './chatThreadServiceTypes';

export interface SemanticCheckpointMeta {
  // Semantic enrichment — all fields optional for backward compatibility
  checkpointId: string;               // UUID, stable for this checkpoint event
  label: string | null;               // user-given name (null = auto-generated)
  autoLabel: string;                  // e.g. "Before: edit AuthService.ts"
  intent: ClassifiedIntent | null;    // the classified intent at time of checkpoint
  planStepIndex: number | null;       // which step of the plan this corresponds to
  gitRef: string | null;              // git commit SHA or branch:HEAD at checkpoint time
  diffSummary: FileDiffSummary[];     // compact per-file diff (not full content — saves space)
  executionPhase: 'pre_user' | 'pre_tool' | 'post_llm' | 'user_named';
  timestamp: number;                  // unix epoch ms
  parentCheckpointId: string | null;  // for branching (null = root)
  branchName: string | null;          // if this checkpoint starts a branch
}

export interface FileDiffSummary {
  filePath: string;                   // relative to workspace root
  changeType: 'created' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
  // NOTE: full diff stored only if < 10KB; otherwise reference to file snapshot
  compactDiff: string | null;
}

// The enriched checkpoint (the existing CheckpointEntry plus semantic meta)
export type EnrichedCheckpointEntry = CheckpointEntry & {
  semanticMeta?: SemanticCheckpointMeta;  // optional = backward compatible
}
```

This is a pure **additive** change to the type system. The discriminated union `role: 'checkpoint'` is unchanged. Existing code that reads `CheckpointEntry` still compiles — the optional `semanticMeta` field is simply ignored by old code.

### 3.4 Semantic Checkpoint Service (`browser/semanticCheckpointService.ts`)

This service runs **alongside** the existing checkpoint logic, not in place of it. It subscribes to the same checkpoint-creation events and writes enriched metadata to a secondary store:

```typescript
export const ISemanticCheckpointService = createDecorator<ISemanticCheckpointService>('semanticCheckpointService');

export interface ISemanticCheckpointService {
  // Called by chatThreadService alongside existing _addUserCheckpoint()
  onCheckpointCreated(checkpoint: CheckpointEntry, context: CheckpointContext): Promise<SemanticCheckpointMeta>;
  
  // Browse all checkpoints for a thread with semantic metadata
  getEnrichedHistory(threadId: string): Promise<EnrichedCheckpointEntry[]>;
  
  // Name a checkpoint (user-initiated from timeline UI)
  labelCheckpoint(checkpointId: string, label: string): Promise<void>;
  
  // Get all branches that diverge from a given checkpoint
  getBranchesFrom(checkpointId: string): Promise<CheckpointBranch[]>;
  
  // Start a new branch from a checkpoint (future: branch-and-retry)
  createBranchFrom(checkpointId: string, branchLabel: string): Promise<CheckpointBranch>;
  
  // Semantic search over checkpoints ("find when I had a working auth flow")
  searchCheckpoints(query: string): Promise<EnrichedCheckpointEntry[]>;
}
```

The service stores enriched metadata in the same `void-repo-intelligence.db` SQLite database (new tables, same file):

```sql
-- Table: semantic_checkpoints
CREATE TABLE IF NOT EXISTS semantic_checkpoints (
  checkpoint_id      TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL,
  workspace_hash     TEXT NOT NULL,
  label              TEXT,
  auto_label         TEXT NOT NULL,
  intent_json        TEXT,         -- JSON of ClassifiedIntent
  plan_step_index    INTEGER,
  git_ref            TEXT,
  diff_summary_json  TEXT NOT NULL,  -- JSON of FileDiffSummary[]
  execution_phase    TEXT NOT NULL,
  timestamp          INTEGER NOT NULL,
  parent_checkpoint_id TEXT,
  branch_name        TEXT,
  embedding          BLOB,         -- 384-dim float32 vector for semantic search
  INDEX idx_thread (thread_id),
  INDEX idx_workspace (workspace_hash),
  INDEX idx_timestamp (timestamp)
);

-- Table: checkpoint_branches (for branch-and-retry future capability)
CREATE TABLE IF NOT EXISTS checkpoint_branches (
  branch_id          TEXT PRIMARY KEY,
  origin_checkpoint_id TEXT NOT NULL,
  label              TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  thread_id          TEXT NOT NULL,
  FOREIGN KEY (origin_checkpoint_id) REFERENCES semantic_checkpoints(checkpoint_id)
);
```

### 3.5 Semantic Index (`electron-main/semanticIndex/`)

The semantic index enables two capabilities:
1. **Context pack assembly** — find the files most semantically similar to the current user query
2. **Checkpoint search** — find checkpoints matching a natural language description

#### 3.5.1 Embedding Provider (`embeddingProvider.ts`)

Local embeddings using `@xenova/transformers` (already a common Electron embedding choice):
- Model: `all-MiniLM-L6-v2` (384 dimensions, ~23MB)
- Runs entirely in electron-main
- Cached on disk after first download
- Batch size: 32 files per embedding call

```typescript
export interface IEmbeddingProvider {
  embedText(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

class XenovaEmbeddingProvider implements IEmbeddingProvider {
  private _pipeline: AutoModel | null = null;

  async embedText(text: string): Promise<Float32Array> {
    const pipeline = await this._getOrLoadPipeline();
    // Truncate to 512 tokens (model max)
    const truncated = text.slice(0, 2048);
    const output = await pipeline(truncated, { pooling: 'mean', normalize: true });
    return output.data;  // Float32Array, length 384
  }
}
```

#### 3.5.2 SQLite Vector Extension (`semanticIndexDb.ts`)

Use `sqlite-vec` (a SQLite extension for vector similarity search) for the embedding store. This is pure SQLite — no external vector database process:

```typescript
// Loaded via: const db = new Database(dbPath); db.loadExtension('./vec0');
// sqlite-vec provides: CREATE VIRTUAL TABLE ... USING vec0(...)

const SEMANTIC_INDEX_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS code_embeddings USING vec0(
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS code_chunks (
  chunk_id        TEXT PRIMARY KEY,
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,    -- which chunk of the file (for large files)
  chunk_text      TEXT NOT NULL,       -- the actual code text
  start_line      INTEGER,
  end_line        INTEGER,
  language        TEXT,
  last_indexed_at INTEGER NOT NULL
);
-- The chunk_id links code_chunks ↔ code_embeddings (same rowid)
`;
```

**Indexing strategy:**
- Files are chunked at function/class boundaries using simple regex heuristics (no tree-sitter needed)
- Each chunk is ≤ 512 tokens
- Chunk text = file path header + code content (for better retrieval)
- Index is built incrementally: only files with `mtime > last_indexed_at`
- Indexing runs as a background task (low-priority) after workspace scan completes

#### 3.5.3 Semantic Search API

```typescript
export interface SemanticSearchResult {
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  similarity: number;    // cosine similarity 0-1
}

async semanticSearchCode(query: string, topK: number = 10): Promise<SemanticSearchResult[]>
  // Algorithm:
  // 1. Embed the query → Float32Array
  // 2. Run: SELECT c.*, vec_distance_cosine(e.embedding, ?) as dist
  //         FROM code_embeddings e JOIN code_chunks c ON e.rowid = c.chunk_id
  //         WHERE c.workspace_hash = ?
  //         ORDER BY dist ASC LIMIT ?
  // 3. Return top-K with (1 - dist) as similarity score
```

This powers both the `semantic_search_code` tool and the context pack assembly.

### 3.6 Checkpoint Labeling Algorithm

Auto-labels are generated without LLM calls, using deterministic rules:

```typescript
function generateAutoLabel(checkpoint: CheckpointEntry, context: CheckpointContext): string {
  const { type, voidFileSnapshotOfURI } = checkpoint;
  const filePaths = Object.keys(voidFileSnapshotOfURI);
  const primaryFile = filePaths[0]?.split('/').at(-1) ?? 'files';

  switch (type) {
    case 'user_edit':
      return context.isPreUserMessage
        ? `Before: ${context.userMessage?.slice(0, 50) ?? 'user message'}`
        : `After: ${filePaths.length} file(s) — ${primaryFile}`;
    case 'tool_edit':
      return `Tool edit: ${context.toolName} → ${primaryFile}`;
    default:
      return `Checkpoint at ${new Date().toLocaleTimeString()}`;
  }
}
```

### 3.7 Checkpoint Timeline UI (`CheckpointTimeline.tsx`)

A new React component in `browser/react/src/sidebar-tsx/CheckpointTimeline.tsx`. It replaces the existing minimal checkpoint display (which currently just shows a "jump to" link) with a full visual timeline.

**Component structure:**

```tsx
// Placed in SidebarChat.tsx alongside existing checkpoint rendering
// The existing checkpoint row UI is kept — CheckpointTimeline is an optional
// expanded view toggled by a button

interface CheckpointTimelineProps {
  threadId: string;
  currentCheckpointIdx: number;
  onJumpTo: (checkpointId: string) => void;
  onLabel: (checkpointId: string, label: string) => void;
}

// Timeline shows:
// ● [auto-label]  [user label input]  [jump to]  [risk badge]
// │
// ● [Before: Fix auth bug]   🟡 medium  →  edit_file: AuthService.ts
// │
// ● [After: 3 files changed]  ✅ complete  [2 branches]
// │
// ◎ [current] ← highlighted with ring

// Branch indicator: shows "2 branches" if multiple branches diverge from a point
// Clicking expands to show branch list with labels
```

The timeline component reads from `ISemanticCheckpointService.getEnrichedHistory()` which returns the full enriched checkpoint list sorted by timestamp.

---

## 4. Process Wiring Reference

Every new file categorized by process layer — the most critical architectural constraint.

### 4.1 `common/` — Shared types only (no imports, no node_modules)

| File | Contents |
|------|----------|
| `common/repoIntelligenceTypes.ts` | `WorkspaceProfile`, `CommandEntry`, `FrameworkEntry`, `REPO_INTEL_CHANNEL` |
| `common/intentClassifierTypes.ts` | `IntentType`, `RiskLevel`, `ClassifiedIntent` |
| `common/toolRegistry.ts` | `ToolRegistryEntry`, `ToolCategory`, `TOOL_REGISTRY` (Map) |
| `common/semanticCheckpointTypes.ts` | `SemanticCheckpointMeta`, `FileDiffSummary`, `EnrichedCheckpointEntry`, `CheckpointBranch` |
| `common/semanticIndexTypes.ts` | `SemanticSearchResult`, `EmbeddingVector`, `SEMANTIC_INDEX_CHANNEL` |

### 4.2 `browser/` — Renderer process (no node_modules, IPC proxies to main)

| File | Role | Dependencies |
|------|------|--------------|
| `browser/repoIntelligenceService.ts` | IPC proxy | `IMainProcessService`, `IWorkspaceContextService` |
| `browser/intentClassifierService.ts` | LLM classifier | `ILLMMessageService`, `IRepoIntelligenceService` |
| `browser/contextPackService.ts` | Context assembly | `IRepoIntelligenceService`, `ISemanticIndexService` |
| `browser/semanticCheckpointService.ts` | Enriched checkpoints | `IMainProcessService`, `IChatThreadService` |
| `browser/react/src/sidebar-tsx/CheckpointTimeline.tsx` | UI component | `ISemanticCheckpointService` via React context |

### 4.3 `electron-main/` — Main process (full Node.js, SQLite, child_process)

| File | Role | Key Dependencies |
|------|------|-----------------|
| `electron-main/repoIntelligence/repoIntelligenceService.impl.ts` | SQLite + scan + LLM | `better-sqlite3`, child services |
| `electron-main/repoIntelligence/repoIntelligenceDb.ts` | SQLite schema + helpers | `better-sqlite3` |
| `electron-main/repoIntelligence/workspaceScanner.ts` | File crawler | Node.js `fs`, `path` |
| `electron-main/repoIntelligence/commandDetector.ts` | Config file parser | Node.js `fs` |
| `electron-main/repoIntelligence/repoIntelligenceChannel.ts` | IPC channel | `ProxyChannel` |
| `electron-main/gitToolService.ts` | Git command execution | `child_process.execFile` |
| `electron-main/semanticIndex/semanticIndexService.impl.ts` | Vector index + search | `better-sqlite3`, `@xenova/transformers` |
| `electron-main/semanticIndex/semanticIndexDb.ts` | SQLite-vec schema | `better-sqlite3`, `sqlite-vec` extension |
| `electron-main/semanticIndex/embeddingProvider.ts` | Local embeddings | `@xenova/transformers` |
| `electron-main/semanticIndex/semanticIndexChannel.ts` | IPC channel | `ProxyChannel` |

---

## 5. IPC Channel Manifest

All new IPC channels follow the existing Void naming convention (`void-channel-*`):

| Channel Name | Direction | Methods |
|--------------|-----------|---------|
| `void-channel-repoIntelligence` | browser → main | `getProfile(workspaceRoot)`, `refreshProfile(workspaceRoot)` |
| `void-channel-gitTools` | browser → main | `getGitStatus(root)`, `getGitDiff(root, staged)`, `getGitLog(root, n)`, `createBranch(root, name)` |
| `void-channel-semanticIndex` | browser → main | `semanticSearchCode(query, topK)`, `getIndexStats()`, `triggerReindex()` |
| `void-channel-semanticCheckpoint` | browser → main | `getEnrichedHistory(threadId)`, `labelCheckpoint(id, label)`, `createBranch(id, label)`, `searchCheckpoints(query)` |

---

## 6. Minimal Touch Points in Existing Files

These are the **only** lines changed in existing Void files. Each change is isolated and additive.

### 6.1 `common/chatThreadServiceTypes.ts`

```typescript
// ADD after existing CheckpointEntry type definition:
import type { SemanticCheckpointMeta } from './semanticCheckpointTypes';

// Extend CheckpointEntry to optionally carry semantic metadata:
export type CheckpointEntry = {
  role: 'checkpoint';
  type: 'user_edit' | 'tool_edit';
  voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot };
  userModifications?: { voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot } };
  semanticMeta?: SemanticCheckpointMeta;   // ADD: optional, backward compatible
};
```

### 6.2 `common/toolsServiceTypes.ts`

```typescript
// Extend BuiltinToolName union — ADD 12 new names, keep all existing:
export type BuiltinToolName =
  // ... existing names unchanged ...
  | 'get_git_status' | 'get_git_diff' | 'get_git_log' | 'create_git_branch'
  | 'search_symbols' | 'get_file_outline' | 'get_dependency_graph'
  | 'run_build' | 'run_tests' | 'run_lint' | 'run_typecheck'
  | 'semantic_search_code';
```

### 6.3 `common/prompt/prompts.ts`

```typescript
// ADD: import + function for repo context block
import { buildRepoContextBlock, getIntentAwareToolSubset } from './repoIntelligencePromptHelpers';

// ADD: 12 new entries to builtinTools array (existing entries unchanged)
// ADD: buildRepoContextBlock() call at top of getSystemPrompt()
// ADD: getIntentAwareToolSubset() call in availableTools()
```

### 6.4 `browser/void.contribution.ts`

```typescript
// ADD: 4 new registerSingleton() calls for new browser services
registerSingleton(IRepoIntelligenceService, RepoIntelligenceService, InstantiationType.Eager);
registerSingleton(IIntentClassifierService, IntentClassifierService, InstantiationType.Eager);
registerSingleton(IContextPackService, ContextPackService, InstantiationType.Eager);
registerSingleton(ISemanticCheckpointService, SemanticCheckpointService, InstantiationType.Eager);
```

### 6.5 `browser/chatThreadService.ts`

```typescript
// ADD: inject new services in constructor (3 new @inject decorators)
constructor(
  // ... existing injections unchanged ...
  @IRepoIntelligenceService private readonly _repoIntelligenceService: IRepoIntelligenceService,
  @IIntentClassifierService private readonly _intentClassifierService: IIntentClassifierService,
  @ISemanticCheckpointService private readonly _semanticCheckpointService: ISemanticCheckpointService,
)

// ADD: 3 lines before _runChatAgent() in addUserMessageAndStreamResponse()
const repoCtx = this._repoIntelligenceService.getProfileSync();
const intent = await this._intentClassifierService.classify(userMessage, repoCtx);
this._setStreamState(threadId, { ...current, intent });

// ADD: 2 lines inside _addUserCheckpoint() after existing checkpoint creation
const meta = await this._semanticCheckpointService.onCheckpointCreated(checkpoint, { threadId, intent });
// (assigns checkpoint.semanticMeta = meta — additive field)

// ADD: sandbox guard in _runToolCall() — 4 lines
const registryEntry = TOOL_REGISTRY.get(toolCallName);
if (registryEntry?.requiresSandbox && !this._hasSandboxContext(threadId)) {
  this._addErrorMessageToThread(threadId, `"${toolCallName}" requires sandbox context`);
  return { awaitingUserApproval: false };
}
```

### 6.6 `browser/toolsService.ts`

```typescript
// ADD: 12 new case blocks in the existing switch statement inside callTool()
// Each case follows the exact same pattern as existing cases
// ADD: IRepoIntelligenceService injection to constructor
// ADD: IGitToolService injection to constructor (proxy to electron-main)
// ADD: ISemanticIndexService injection to constructor (proxy to electron-main)
```

### 6.7 `browser/react/src/sidebar-tsx/SidebarChat.tsx`

```typescript
// ADD: import CheckpointTimeline
import { CheckpointTimeline } from './CheckpointTimeline';

// ADD: Render inside existing checkpoint message rendering block
// The existing checkpoint row is kept; CheckpointTimeline renders below it when expanded
{checkpoint.semanticMeta && showTimeline && (
  <CheckpointTimeline
    threadId={threadId}
    currentCheckpointIdx={currCheckpointIdx}
    onJumpTo={handleJumpToCheckpoint}
    onLabel={handleLabelCheckpoint}
  />
)}
```

---

## 7. Dependency Additions to `package.json`

All new dependencies are in `electron-main/` and therefore safe to import as `node_modules`:

```json
{
  "dependencies": {
    "better-sqlite3": "^9.4.3",          // SQLite driver — already used in VS Code internals
    "@xenova/transformers": "^2.17.2",    // Local embedding model (all-MiniLM-L6-v2)
    "sqlite-vec": "^0.1.3"               // SQLite vector extension for similarity search
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8"
  }
}
```

`react`, `tailwindcss`, `typescript`, `electron` are already present.

Note: `better-sqlite3` requires native compilation. Add it to the `electron-rebuild` step in the existing build pipeline. The `void-builder` GitHub Actions already rebuild native modules — add `better-sqlite3` to the rebuild list alongside any existing native deps.

---

## 8. Implementation Sequence (Hard Dependencies)

The phases must be built in this strict order:

```
Phase A: Repo Intelligence Layer
  → common/repoIntelligenceTypes.ts
  → electron-main/repoIntelligence/repoIntelligenceDb.ts
  → electron-main/repoIntelligence/workspaceScanner.ts
  → electron-main/repoIntelligence/commandDetector.ts
  → electron-main/repoIntelligence/repoIntelligenceService.impl.ts
  → electron-main/repoIntelligence/repoIntelligenceChannel.ts
  → browser/repoIntelligenceService.ts
  → common/prompt/prompts.ts (system prompt injection)
  ✓ Testable: workspace opens, profile is logged to console

Phase B: Tool Registry + Intent Classifier
  → common/intentClassifierTypes.ts
  → common/toolRegistry.ts
  → browser/intentClassifierService.ts
  → common/toolsServiceTypes.ts (extend BuiltinToolName)
  → common/prompt/prompts.ts (add 12 tool definitions)
  → browser/toolsService.ts (add 12 implementations)
  → electron-main/gitToolService.ts
  → browser/chatThreadService.ts (intent pre-classification)
  ✓ Testable: "what's the git status?" → agent calls get_git_status
  ✓ Testable: "run the tests" → agent calls run_tests with profile command

Phase C: Semantic Checkpoint + Index
  → common/semanticCheckpointTypes.ts
  → common/semanticIndexTypes.ts
  → common/chatThreadServiceTypes.ts (extend CheckpointEntry)
  → electron-main/semanticIndex/embeddingProvider.ts
  → electron-main/semanticIndex/semanticIndexDb.ts
  → electron-main/semanticIndex/semanticIndexService.impl.ts
  → electron-main/semanticIndex/semanticIndexChannel.ts
  → browser/semanticCheckpointService.ts
  → browser/chatThreadService.ts (checkpoint enrichment calls)
  → browser/react/src/sidebar-tsx/CheckpointTimeline.tsx
  → browser/react/src/sidebar-tsx/SidebarChat.tsx (render timeline)
  ✓ Testable: checkpoints appear with auto-labels in timeline
  ✓ Testable: semantic_search_code returns relevant file chunks

Phase D: Context Pack Assembly
  → browser/contextPackService.ts
  → browser/chatThreadService.ts (assemble pack before agent loop)
  ✓ Testable: agent uses semantically relevant files without being told which files
```

---

## 9. Testing Strategy

### 9.1 Unit Tests (per service)

Each new service has a paired test file under the existing Void test pattern:

| Service | Test file |
|---------|-----------|
| `workspaceScanner.ts` | `electron-main/repoIntelligence/test/workspaceScanner.test.ts` |
| `commandDetector.ts` | `electron-main/repoIntelligence/test/commandDetector.test.ts` |
| `intentClassifierService.ts` | `browser/test/intentClassifierService.test.ts` |
| `semanticIndexService.impl.ts` | `electron-main/semanticIndex/test/semanticIndexService.test.ts` |

### 9.2 Integration Tests

- **Repo Intelligence:** Open a known Node.js repo → verify profile languages = `['TypeScript', 'JavaScript']`, build command detected, LLM summary non-null.
- **Tool Registry:** Call `run_build` in agent mode → verify it reads profile command, runs in terminal, returns output.
- **Intent Classifier:** Send "fix the bug in line 42" → verify `type = 'bug_fix'`, `risk = 'medium'`.
- **Semantic Index:** Index a 500-file repo → query "authentication logic" → verify top result contains auth-related code.
- **Checkpoint Timeline:** Run a 3-step agent task → verify 5+ checkpoints appear with auto-labels.

### 9.3 Regression Safeguard

The golden test: **the existing agent loop must work identically with all new services injected but returning null/empty.** All new services degrade gracefully:
- `IRepoIntelligenceService.getProfileSync()` returning `null` → system prompt is unchanged from baseline
- `IIntentClassifierService.classify()` failing → `intent = { type: 'unknown' }` → all tools available
- `ISemanticCheckpointService.onCheckpointCreated()` failing → checkpoint created normally (existing code path)
- `ISemanticIndexService.semanticSearchCode()` failing → context pack is assembled without semantic files

---

## 10. Architectural Invariants (Never Violate)

1. **Browser never imports node_modules.** SQLite, `child_process`, `@xenova/transformers` stay in `electron-main/` only.
2. **All electron-main services are accessed via ProxyChannel.** No direct import across the process boundary.
3. **New tools added to `prompts.ts` must also be added to `toolsServiceTypes.ts` BuiltinToolName union.** Type safety is maintained by the existing discriminated union pattern.
4. **`CheckpointEntry.semanticMeta` is always optional.** Existing checkpoint read code (`jumpToCheckpointBeforeMessageIdx`) never references `semanticMeta`. Old checkpoints loaded from storage work without the field.
5. **New services registered in `browser/void.contribution.ts` use `InstantiationType.Eager` if they need to initialize on workspace open** (e.g., `IRepoIntelligenceService`), `InstantiationType.Delayed` if they only activate on first use (e.g., `ISemanticIndexService`).
6. **The agent loop's `_runChatAgent()` is not refactored.** All changes are injected as additional method calls before or after existing logic.
7. **React components follow the existing two-stage build pipeline** (scope-tailwind → tsup). New components added to `browser/react/src/` are included in the existing `tsup.config.js` entry points. New component bundles require a new entry in `build.js`.

---

## 11. Quick Reference Summary

| Enhancement | New Files | Existing Files Modified | IPC Channels |
|------------|-----------|------------------------|-------------|
| Repo Intelligence | 7 | 4 (minimal) | 1 |
| Tool Registry + Intent | 5 | 4 (additive) | 1 |
| Semantic Checkpoints + Index | 8 | 4 (additive) | 2 |
| **Total** | **20** | **4** (shared) | **4** |

All 20 new files follow the three-layer architecture. The 4 existing files receive only additive modifications: new imports, new optional fields, new `registerSingleton` calls, new `case` blocks in existing switches.

The Void user sees: a richer sidebar with checkpoint timeline, faster agent startup (profile pre-loaded), smarter tool choices matched to intent, and meaningful checkpoint labels that tell the story of what the agent was doing — without any change to the existing chat UI, apply/diff flow, autocomplete, settings, or keybinding behavior.
