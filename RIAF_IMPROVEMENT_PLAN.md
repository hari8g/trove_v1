# RIAF — Repository Intelligence Improvement Plan
> Full study based on direct source read of `repoIntelligenceDb.ts` (1,403 lines),
> `codeChunker.ts` (286 lines), `repoIntelligenceService.impl.ts` (724 lines),
> `workspaceScanner.ts` (331 lines), and all 11 domain indexers.

---

## Current State Analysis

### What the source code reveals

**FTS query builder (`buildFtsQuery`, line 1390 of repoIntelligenceDb.ts):**
```typescript
const tokens = query.toLowerCase()
  .replace(FTS_SPECIAL_CHARS, ' ')
  .split(/\s+/)
  .filter(t => t.length >= 2);
return tokens.map(t => `"${t}"*`).join(' OR ');
```
This produces: `"order"* OR "controller"*` for the query "order controller".
Problem: `OrderController` is stored as one token `ordercontroller` by SQLite's porter/ascii
tokenizer. The query never matches. Natural language queries against code fail silently.

**Chunk rebuild (`replaceChunks`, line 972 of repoIntelligenceDb.ts):**
```typescript
await this._run(`DELETE FROM chunks_fts WHERE workspace_hash = ?`, [workspaceHash]);
// then inserts all 8,040 chunks one by one
```
This is a full wipe and rebuild for any change. No per-file granularity despite symbols
being incremental (SHA256 hash-based per file, working correctly).

**SKIP_LANGUAGES (codeChunker.ts, line 14):**
```typescript
const SKIP_LANGUAGES = new Set([
  'Markdown', 'JSON', 'YAML', 'TOML', 'HTML', 'CSS', 'SCSS', 'Sass', 'Less',
]);
```
In the STaaS workspace: 607 YAML files, 174 SQL files, 135 Markdown files never indexed.
SQL schema definitions, K8s configs, ADR documents — all invisible to `search_codebase`.

**No file watcher:** `repoIntelligenceService.impl.ts` has zero `onDidChange`, `watch`,
or `chokidar` references. The 24h stale check is the only refresh mechanism.

---

## Phase 1 — Quick Wins (no new dependencies)

### Improvement 1: CamelCase + snake_case tokenizer

**Files:** `repoIntelligenceDb.ts` + `codeChunker.ts`
**Effort:** 1 day

**The problem:** SQLite's `porter ascii` tokenizer treats `OrderController` as one
lowercase string `ordercontroller`. The query `"order"*` does not match it.

**Fix — pre-process chunk text before FTS insertion:**

```typescript
// Add to repoIntelligenceDb.ts (new utility function):
function splitIdentifiers(text: string): string {
  return text
    // camelCase → camel Case
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // PascalCase sequences → Pascal Case sequences
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // snake_case → snake case
    .replace(/_/g, ' ')
    // kebab-case → kebab case (preserve hyphens in non-identifier contexts)
    .replace(/([a-zA-Z])-([a-zA-Z])/g, '$1 $2')
    // dot.notation → dot notation
    .replace(/([a-zA-Z])\.([a-zA-Z])/g, '$1 $2');
}

// In replaceChunks() before FTS INSERT, apply to chunk_text:
const processedText = splitIdentifiers(chunk.content);
// INSERT INTO chunks_fts (chunk_text, ...) VALUES (processedText, ...)
```

**In buildFtsQuery — also apply to the query:**
```typescript
const buildFtsQuery = (query: string): string | null => {
  const processedQuery = splitIdentifiers(query);   // ← add this
  const tokens = processedQuery
    .toLowerCase()
    .replace(FTS_SPECIAL_CHARS, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  // ... rest unchanged
};
```

**Result:** `search_codebase("order controller")` now finds `OrderController.java`,
`getOrderById` now matches a query for "get order by id". Requires a full chunk rebuild
after the change (one-time cost).

---

### Improvement 2: Per-file incremental chunk updates

**Files:** `repoIntelligenceDb.ts` + `repoIntelligenceService.impl.ts`
**Effort:** 1 day

**The problem:** `replaceChunks()` deletes all chunks and reinserts all of them.
`_needsChunkRebuild()` correctly detects when chunks need updating, but the rebuild
is always all-or-nothing.

**Fix — add per-file chunk replace method and file hash tracking for chunks:**

```typescript
// repoIntelligenceDb.ts — new method:
async replaceChunksForFile(
  workspaceHash: string,
  filePath: string,
  chunks: CodeChunk[],
): Promise<void> {
  await this._run('BEGIN');
  try {
    // Delete only this file's chunks
    await this._run(
      `DELETE FROM chunks_fts WHERE workspace_hash = ? AND file_path = ?`,
      [workspaceHash, filePath],
    );
    // Insert only this file's new chunks
    for (const chunk of chunks) {
      const processedText = splitIdentifiers(chunk.content);
      await this._run(
        `INSERT INTO chunks_fts (chunk_text, file_path, workspace_hash, start_line, end_line, chunk_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [processedText, filePath, workspaceHash,
         chunk.startLine, chunk.endLine, chunk.chunkType],
      );
    }
    await this._run('COMMIT');
  } catch (err) {
    await this._run('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Also add chunk hash tracking (parallel to file_hashes for symbols):
async getChunkFileHashes(workspaceHash: string): Promise<Map<string, string>>
async upsertChunkFileHash(workspaceHash: string, filePath: string, hash: string): Promise<void>
```

**Update `_rebuildChunks` in `repoIntelligenceService.impl.ts` to be incremental:**
```typescript
private async _rebuildChunks(
  workspaceRoot: string, hash: string, fileMeta: FileMetadataEntry[]
): Promise<void> {
  const storedChunkHashes = await this._db.getChunkFileHashes(hash);
  let updatedFiles = 0;

  for (const file of fileMeta) {
    if (!file.language || SKIP_LANGUAGES.has(file.language)) continue;
    const absPath = join(workspaceRoot, file.filePath);
    let content: string;
    try { content = readFileSync(absPath, 'utf8'); } catch { continue; }

    const currentHash = sha256(content).slice(0, 32);
    if (storedChunkHashes.get(file.filePath) === currentHash) continue;

    // Only rebuild this file's chunks
    const chunks = buildChunksForFile(workspaceRoot, hash, file, content);
    await this._db.replaceChunksForFile(hash, file.filePath, chunks);
    await this._db.upsertChunkFileHash(hash, file.filePath, currentHash);
    updatedFiles++;
  }

  console.log(`[RepoIntelligence] Updated chunks for ${updatedFiles} changed files`);
}
```

**Result:** Editing 1 file updates 1 file's chunks in <100ms instead of 10s full rebuild.

---

### Improvement 3: Index SQL, YAML config, and Markdown

**Files:** `codeChunker.ts` + `repoIntelligenceDb.ts`
**Effort:** 1 day

**The problem:** 174 SQL files, 607 YAML files, 135 Markdown files are in `SKIP_LANGUAGES`
and invisible to `search_codebase`. Developers can't find schema definitions, K8s configs,
or ADR documentation through the agent.

**Fix — add boundary patterns for SQL, YAML, and Markdown:**

```typescript
// In codeChunker.ts — remove from SKIP_LANGUAGES, add to LANGUAGE_BOUNDARIES:

// Remove 'Markdown', 'YAML', 'SQL' from SKIP_LANGUAGES
// (keep JSON, CSS, SCSS as they rarely contain meaningful search content)

// Add boundary patterns:
const LANGUAGE_BOUNDARIES: Record<string, BoundaryPattern[]> = {
  // ... existing patterns ...

  SQL: [
    { regex: /^CREATE\s+TABLE\s+\w/im, chunkType: 'class' },       // table = class analogue
    { regex: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+\w/im, chunkType: 'function' },
    { regex: /^ALTER\s+TABLE\s+\w/im, chunkType: 'block' },
    { regex: /^CREATE\s+INDEX\s+\w/im, chunkType: 'block' },
  ],

  YAML: [
    // Top-level keys (depth-0) as chunk boundaries
    { regex: /^\w[\w-]*:/m, chunkType: 'block' },
  ],

  Markdown: [
    // H1 and H2 headings as chunk boundaries (ADR sections, README sections)
    { regex: /^#{1,2}\s+\w/m, chunkType: 'block' },
  ],
};
```

**For YAML, cap chunk depth** to avoid chunking every nested K8s property:
Add a YAML-specific chunker that only creates chunks at top-level keys, producing one
chunk per top-level YAML document section (e.g., the whole `spring.datasource` block).

**Result:** `search_codebase("order table columns")` finds the SQL CREATE TABLE for orders.
`search_codebase("database connection")` finds `spring.datasource.url` in application.yml.
`search_codebase("multi tenancy architecture")` finds the ADR document.

---

## Phase 2 — High Impact (structural improvements)

### Improvement 4: Real-time file watching

**Files:** `repoIntelligenceService.impl.ts` (main) + new `fileWatcher.ts`
**Effort:** 3 days
**Dependency:** `chokidar` (already available as VS Code uses it internally)

**The problem:** The agent edits files. The index is stale until the next workspace open
or 24h expiry. If the agent searches for something it just wrote, it finds nothing.

**Architecture:**

```typescript
// electron-main/repoIntelligence/fileWatcher.ts — NEW FILE

import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { join } from 'path';

const WATCH_DEBOUNCE_MS = 2000;
const IGNORE_PATTERNS = [
  '**/node_modules/**', '**/.git/**', '**/dist/**',
  '**/target/**', '**/build/**', '**/.gradle/**',
  '**/*.class', '**/*.pyc',
];

export type FileChangeEvent = {
  type: 'add' | 'change' | 'unlink';
  filePath: string;  // relative to workspaceRoot
};

export class WorkspaceFileWatcher extends EventEmitter {
  private _watcher: chokidar.FSWatcher | null = null;
  private _pending: Map<string, FileChangeEvent> = new Map();
  private _timer: NodeJS.Timeout | null = null;

  start(workspaceRoot: string): void {
    this._watcher = chokidar.watch(workspaceRoot, {
      ignored: IGNORE_PATTERNS,
      persistent: true,
      ignoreInitial: true,   // don't fire for existing files
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this._watcher
      .on('add',    (path) => this._schedule(path, workspaceRoot, 'add'))
      .on('change', (path) => this._schedule(path, workspaceRoot, 'change'))
      .on('unlink', (path) => this._schedule(path, workspaceRoot, 'unlink'));
  }

  private _schedule(absPath: string, root: string, type: FileChangeEvent['type']): void {
    const relPath = absPath.replace(root, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
    this._pending.set(relPath, { type, filePath: relPath });

    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const events = [...this._pending.values()];
      this._pending.clear();
      this.emit('changes', events);
    }, WATCH_DEBOUNCE_MS);
  }

  stop(): void {
    this._watcher?.close();
    if (this._timer) clearTimeout(this._timer);
  }
}
```

**Wire into `RepoIntelligenceMainService`:**
```typescript
// repoIntelligenceService.impl.ts — additions:

private _watcher: WorkspaceFileWatcher | null = null;

// In _scanWorkspace(), after initial scan:
this._watcher = new WorkspaceFileWatcher();
this._watcher.on('changes', (events: FileChangeEvent[]) => {
  this._handleFileChanges(workspaceRoot, hash, events);
});
this._watcher.start(workspaceRoot);

private async _handleFileChanges(
  workspaceRoot: string,
  hash: string,
  events: FileChangeEvent[],
): Promise<void> {
  for (const event of events) {
    if (event.type === 'unlink') {
      // Remove chunks + symbols for deleted file
      await this._db.replaceChunksForFile(hash, event.filePath, []);
      await this._db.replaceSymbolsForFile(hash, event.filePath, []);
      continue;
    }
    // Re-index changed/added file
    const absPath = join(workspaceRoot, event.filePath);
    const language = detectLanguage(event.filePath);
    if (!language || SKIP_LANGUAGES.has(language)) continue;

    let content: string;
    try { content = readFileSync(absPath, 'utf8'); } catch { continue; }

    // Update chunks (Improvement 2)
    const chunks = buildChunksForFile(workspaceRoot, hash, { filePath: event.filePath, language }, content);
    await this._db.replaceChunksForFile(hash, event.filePath, chunks);

    // Update symbols
    const symbols = extractSymbolsFromFile(hash, event.filePath, content, language);
    await this._db.replaceSymbolsForFile(hash, event.filePath, symbols);
  }

  // Fire event so status bar + agent know index is fresh
  this._onDidChangeChunkIndex.fire(await this._db.getChunkCount(hash));
}
```

**Result:** File saved → 2 second debounce → only that file's chunks and symbols updated
→ next `search_codebase` reflects the edit. Agent self-correction loops work correctly.

---

### Improvement 5: Import graph for TypeScript / JavaScript

**Files:** New `universalImportExtractor.ts` + new SQLite table `ucg_import_edges`
**Effort:** 4 days

**The problem:** The agent can find a file but can't answer "what imports this?" for
TypeScript/JavaScript. Maven blast radius exists for Java, but nothing exists for
the frontend/backend TypeScript codebase.

**New SQLite table:**
```sql
CREATE TABLE IF NOT EXISTS ucg_import_edges (
  workspace_hash  TEXT NOT NULL,
  from_file       TEXT NOT NULL,    -- relative path of importing file
  to_module       TEXT NOT NULL,    -- raw import string
  resolved_file   TEXT,             -- resolved relative path (null for external)
  is_external     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_hash, from_file, to_module)
);
CREATE INDEX IF NOT EXISTS idx_import_to ON ucg_import_edges(workspace_hash, resolved_file);
CREATE INDEX IF NOT EXISTS idx_import_from ON ucg_import_edges(workspace_hash, from_file);
```

**Import extraction patterns:**
```typescript
// universalImportExtractor.ts
const TS_JS_PATTERNS = [
  /(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
  /(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  /(?:^|\n)\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
  /(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,   // dynamic imports
];
```

**New tool added to toolsService.ts:**
```typescript
// get_import_graph tool:
'get_import_graph': {
  validateParams: (p) => ({ uri: URI.file(p.uri as string), direction: p.direction ?? 'both' }),
  callTool: async ({ uri, direction }) => {
    const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
    const relPath = relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
    const result = await riafService.getImportGraph(workspaceRoot, relPath, direction);
    return { result };
  },
  stringOfResult: (params, result) =>
    `Import graph for ${params.uri.fsPath}:\n` +
    (result.imports.length ? `  Imports (${result.imports.length}): ${result.imports.join(', ')}\n` : '') +
    (result.importedBy.length ? `  Imported by (${result.importedBy.length}): ${result.importedBy.join(', ')}\n` : '') +
    (result.externalDeps.length ? `  External deps: ${result.externalDeps.join(', ')}` : ''),
}
```

**Update `builtinTools` in prompts.ts** to include this tool.

**Result:** `get_import_graph(uri="src/services/AuthService.ts")` returns all files that
import it and all files it imports. Change impact analysis for TS/JS, comparable to
`get_maven_impact` for Java.

---

### Improvement 6: Smart context assembly

**Files:** `convertToLLMMessageService.ts` + `repoIntelligenceService.ts`
**Effort:** 3 days

**The problem:** Every agent turn gets the same static `WorkspaceProfile` regardless of
what the agent is currently working on. The profile is serialized at a fixed char limit
without knowing what's relevant.

**New method on `IRepoIntelligenceMainService`:**
```typescript
getContextualProfile(
  workspaceRoot: string,
  options: {
    activeUri?: string;        // currently open file
    recentlyEditedUris?: string[];  // files edited in this session
    query?: string;            // current user query (for semantic relevance)
  }
): Promise<ContextualProfile>
```

**`ContextualProfile` shape:**
```typescript
type ContextualProfile = WorkspaceProfile & {
  // Files related to activeUri via import graph
  relatedFiles: string[];
  // Test files that cover the active file
  coveringTests: string[];
  // Files changed in last 20 git commits (from Improvement 9)
  recentlyChanged: string[];
  // Symbols in the active file (pre-loaded, saves a read_file call)
  activeFileSymbols: ExtractedSymbol[];
  // Files the agent accessed most in previous sessions
  hotFiles: string[];
}
```

**In `convertToLLMMessageService.ts` — build contextual profile before each turn:**
```typescript
// Before calling serializeWorkspaceProfileForPrompt():
const contextualProfile = await riafService.getContextualProfile(workspaceRoot, {
  activeUri: activeEditor?.uri.fsPath,
  recentlyEditedUris: this._editedFilesThisSession,
  query: lastUserMessage,
});

// serializeWorkspaceProfileForPrompt() uses contextualProfile
// Additional context injected near the top of the system message:
// <active_context>
//   Active file: src/services/AuthService.ts
//   Related files: src/controllers/AuthController.ts, src/middleware/jwtMiddleware.ts
//   Covering tests: test/services/AuthService.test.ts
// </active_context>
```

**Result:** Agent starts a task with relevant file context already in its system message.
Fewer exploratory read calls needed. Tasks start with more relevant context from turn 1.

---

### Improvement 7: Test-to-source mapping

**Files:** New `testCoverageIndexer.ts`
**Effort:** 2 days

**The problem:** Agent edits source but doesn't know which test file covers it. Must
search manually or guess. `agentVerificationHints.ts` nudges to verify but can't
point to the specific test file.

**Mapping strategy — heuristic-based (works without running tests):**

```typescript
// testCoverageIndexer.ts
export function buildTestSourceMap(fileMeta: FileMetadataEntry[], workspaceRoot: string): TestSourceEntry[] {
  const testFiles = fileMeta.filter(f => isTestFile(f.filePath));
  const sourceFiles = fileMeta.filter(f => !isTestFile(f.filePath) && isSourceFile(f.filePath));

  const map: TestSourceEntry[] = [];

  for (const testFile of testFiles) {
    // Strategy 1: Name proximity (OrderService.test.ts → OrderService.ts)
    const testBaseName = basename(testFile.filePath)
      .replace(/\.(test|spec|_test|Test)\.(ts|js|java|py)$/, '')
      .toLowerCase();

    const matchingSource = sourceFiles.find(sf =>
      basename(sf.filePath).toLowerCase().replace(/\.(ts|js|java|py)$/, '') === testBaseName
    );

    if (matchingSource) {
      map.push({ testFile: testFile.filePath, sourceFile: matchingSource.filePath, confidence: 'high' });
      continue;
    }

    // Strategy 2: Import analysis (test imports the source file)
    const testContent = readFileSafe(join(workspaceRoot, testFile.filePath));
    if (testContent) {
      for (const sourceFile of sourceFiles) {
        const moduleName = basename(sourceFile.filePath).replace(/\.[^.]+$/, '');
        if (testContent.includes(`'${moduleName}'`) || testContent.includes(`"${moduleName}"`)) {
          map.push({ testFile: testFile.filePath, sourceFile: sourceFile.filePath, confidence: 'medium' });
        }
      }
    }
  }

  return map;
}
```

**New tool:**
```typescript
'get_tests_for_file': {
  description: 'Returns the test files that cover a given source file.',
  callTool: async ({ uri }) => {
    const coveringTests = await riafService.getTestsForFile(workspaceRoot, relPath);
    return { result: coveringTests };
  },
}
```

**Result:** After editing `OrderService.java`, the agent calls
`get_tests_for_file(uri=OrderService.java)` → `["OrderServiceTest.java"]` → runs that test.
No search needed. `agentVerificationHints.ts` can now reference the exact test file.

---

## Phase 3 — Advanced Capabilities

### Improvement 8: Hybrid search — BM25 + local vector embeddings

**Files:** New `embeddingService.ts` + new `ucg_embeddings` table
**Effort:** 1 week
**Dependency:** `sqlite-vec` (SQLite extension for vector operations) OR embedding via LiteLLM

**The problem:** BM25 is great for exact keyword matching but terrible for conceptual
queries. "find authentication logic" misses `JwtService`, `KeycloakAdapter`, `TokenVerifier`
because none contain the literal string "authentication".

**Architecture:**

```typescript
// embeddingService.ts — two modes:

// Mode A: Local embeddings (no API cost, private)
// Use @xenova/transformers for in-process ONNX inference
// Model: all-MiniLM-L6-v2 (22MB, 384 dimensions, fast)
import { pipeline } from '@xenova/transformers';
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const embedding = await embedder(text, { pooling: 'mean', normalize: true });

// Mode B: API embeddings via LiteLLM
// Uses the same LiteLLM endpoint already configured in Trove
const response = await openai.embeddings.create({
  model: 'text-embedding-3-small',  // or whatever LiteLLM is configured with
  input: text,
});
```

**New SQLite table (using sqlite-vec extension):**
```sql
CREATE VIRTUAL TABLE ucg_embeddings USING vec0(
  embedding float[384]   -- 384 for MiniLM, 1536 for OpenAI ada-002
);
CREATE TABLE ucg_embedding_meta (
  rowid INTEGER PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  chunk_id INTEGER NOT NULL,
  chunk_text TEXT NOT NULL
);
```

**Hybrid search with Reciprocal Rank Fusion (RRF):**
```typescript
async searchChunksHybrid(
  workspaceHash: string,
  query: string,
  limit: number,
): Promise<CodebaseSearchResult[]> {
  // 1. BM25 results
  const bm25Results = await this.searchChunks(workspaceHash, query, limit * 2);

  // 2. Vector results
  const queryEmbedding = await this._embeddingService.embed(query);
  const vectorResults = await this._db.vectorSearch(workspaceHash, queryEmbedding, limit * 2);

  // 3. RRF fusion (k=60 is standard)
  const k = 60;
  const scores = new Map<string, number>();
  bm25Results.forEach((r, i) => {
    const key = `${r.filePath}:${r.startLine}`;
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  });
  vectorResults.forEach((r, i) => {
    const key = `${r.filePath}:${r.startLine}`;
    scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
  });

  // Return top results by combined RRF score
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => /* look up result */);
}
```

**Result:** "find authentication logic" finds `JwtService`, `KeycloakAdapter`, `JWKS resolver`
even though none contain the word "authentication". Conceptual queries work.

---

### Improvement 9: Git-aware context

**Files:** New `gitContextIndexer.ts` + new `git_file_stats` table
**Effort:** 4 days

**The problem:** RIAF has no awareness of git history. Can't answer "what changed recently?"
or "what files change together?" — both highly useful for understanding a codebase.

**Implementation:**
```typescript
// gitContextIndexer.ts
export function indexGitContext(workspaceRoot: string): GitContextResult {
  const exec = (cmd: string) =>
    execSync(cmd, { cwd: workspaceRoot, timeout: 5000 }).toString().trim();

  // Recently changed files (last 30 commits)
  const recentFiles = exec('git log --name-only --pretty=format: -30')
    .split('\n').filter(Boolean);

  // File change frequency (hot files)
  const changeFreq = exec('git log --name-only --pretty=format: -100')
    .split('\n').filter(Boolean)
    .reduce((acc, f) => { acc.set(f, (acc.get(f) ?? 0) + 1); return acc; }, new Map<string, number>());

  // Co-change pairs (files that change together)
  // For each commit, find all pairs of files that changed together
  const commitFiles = exec('git log --name-only --pretty=format:COMMIT -100')
    .split('COMMIT\n').map(block => block.split('\n').filter(Boolean));

  return { recentFiles, changeFreq, commitFiles };
}
```

**New tool:**
```typescript
'get_recently_changed': {
  description: 'Returns files changed in recent git commits, optionally filtered to files related to a given path.',
  callTool: async ({ maxFiles = 20, relatedTo }) => {
    const recentFiles = await riafService.getRecentlyChangedFiles(workspaceRoot, maxFiles, relatedTo);
    return { result: recentFiles };
  },
}
```

**Result:** When a bug is reported, agent calls `get_recently_changed()` to see what changed
in the last week. Co-change analysis tells agent "OrderService and OrderRepository always
change together — if you edited one, check the other."

---

### Improvement 10: Interaction memory — search quality from usage

**Files:** New `riafInteractionTracker.ts` + new `riaf_file_access_log` table
**Effort:** 3 days

**The problem:** Every search starts cold. Files the agent has successfully used in
previous sessions for similar tasks have no advantage over rarely-used files.

**Implementation:**
```typescript
// riafInteractionTracker.ts
// Called every time a file appears in a tool result AND the agent continues successfully:
export async function recordFileAccess(
  workspaceHash: string,
  filePath: string,
  queryThatFoundIt: string,
): Promise<void> {
  await db.run(
    `INSERT INTO riaf_file_access_log (workspace_hash, file_path, query, accessed_at)
     VALUES (?, ?, ?, ?)`,
    [workspaceHash, filePath, queryThatFoundIt, Date.now()],
  );
}

// Compute relevance boost (decays over time):
async getAccessBoostMap(workspaceHash: string): Promise<Map<string, number>> {
  const rows = await db.all(
    `SELECT file_path,
            COUNT(*) * EXP(-0.001 * (JULIANDAY('now') - JULIANDAY(MAX(accessed_at) / 1000.0, 'unixepoch'))) AS boost
     FROM riaf_file_access_log
     WHERE workspace_hash = ?
     GROUP BY file_path
     ORDER BY boost DESC`,
    [workspaceHash],
  );
  return new Map(rows.map(r => [r.file_path, r.boost]));
}
```

**Apply boost in `searchChunks`:**
```typescript
// After getting BM25 results, apply access boost:
const boostMap = await this.getAccessBoostMap(workspaceHash);
return results
  .map(r => ({ ...r, score: r.score + (boostMap.get(r.filePath) ?? 0) * 0.1 }))
  .sort((a, b) => b.score - a.score);
```

**Result:** Files the agent has consistently found useful for this workspace's type of
tasks appear higher in search results. The index gets smarter with usage.

---

## Complete new tool list (additions to existing 27)

| Tool | Phase | Purpose |
|---|---|---|
| `get_import_graph` | 2 | Returns importers and importees for any TS/JS file |
| `get_tests_for_file` | 2 | Returns test files covering a given source file |
| `get_recently_changed` | 3 | Returns recently modified files from git history |
| `get_cochange_files` | 3 | Returns files that typically change alongside a given file |

---

## New SQLite tables

| Table | Phase | Purpose |
|---|---|---|
| `chunk_file_hashes` | 1 | SHA256 per-file for incremental chunk updates |
| `ucg_import_edges` | 2 | TypeScript/JS import graph |
| `test_source_map` | 2 | Test file → source file coverage mapping |
| `ucg_embeddings` | 3 | Vector embeddings (sqlite-vec) |
| `ucg_embedding_meta` | 3 | Metadata for embedding rows |
| `git_file_stats` | 3 | Git change frequency and co-change data |
| `riaf_file_access_log` | 3 | Agent file access history for relevance boosting |

---

## Implementation order

```
Phase 1 (Days 1-3 — no new dependencies, immediate wins):
  Day 1: Improvement 1 — CamelCase FTS tokenizer
          + trigger full chunk rebuild once after change
  Day 2: Improvement 2 — Per-file incremental chunk updates
          + add chunk_file_hashes table
  Day 3: Improvement 3 — SQL/YAML/Markdown indexing
          + rebuild chunks after enabling

Phase 2 (Weeks 1-2 — structural additions):
  Days 4-6:   Improvement 4 — File watcher (chokidar)
  Days 7-10:  Improvement 5 — Import graph (TS/JS)
  Days 11-12: Improvement 6 — Smart context assembly
  Days 13-14: Improvement 7 — Test-to-source mapping

Phase 3 (Weeks 3-5 — advanced capabilities):
  Week 3:   Improvement 8 — Hybrid BM25 + vector search
  Week 4:   Improvement 9 — Git-aware context
  Week 5:   Improvement 10 — Interaction memory
```

After Phase 1 alone: `search_codebase` quality improves dramatically for natural language
queries, index is always current after edits, and 900+ additional files are searchable.
After Phase 2: the agent requires 30-40% fewer exploratory read calls before acting.
After Phase 3: semantic search handles conceptual queries, git context surfaces the
most relevant code for current tasks, and relevance improves with workspace usage.
