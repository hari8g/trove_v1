# Universal Context Graph — Build Plan for Trove v1
> Works for ANY repository loaded in the workspace. Language-agnostic import extraction
> + framework-aware node typing + D3 force graph panel. Integrates with existing RIAF.

---

## Architecture

```
Workspace opens
      │
      ▼
_scanWorkspace() [existing]
      │
      ├─ workspaceScanner.ts  → fileMeta (file list, languages)
      ├─ codeChunker.ts       → chunks (existing)
      │
      └─ UniversalImportExtractor (NEW) ─────────────────────────────┐
              │                                                        │
              │  Per-file, per-language regex import patterns          │
              │  TypeScript/JS: import … from '…' / require('…')      │
              │  Python:       from … import / import …               │
              │  Java/Kotlin:  import …;                              │
              │  Go:           import "…" / import ( "…" )            │
              │  Rust:         use …::; mod …;                        │
              │  C/C++:        #include <…> / #include "…"            │
              │  C#:           using …;                               │
              │  Ruby:         require '…' / require_relative '…'     │
              │  PHP:          use …; / require '…';                  │
              │                                                        │
              ├─ ucg_file_nodes table ─────────────────────────────────┤
              │     (file_path, lang, node_type, layer, entryPoint)    │
              ├─ ucg_import_edges table ───────────────────────────────┤
              │     (from_file, to_file, to_module, edge_type,        │
              │      is_external, resolved)                            │
              └─ ucg_packages table ───────────────────────────────────┤
                    (pkg_path, file_count, is_entry_dir)               │
                                                                        │
GraphAnalyzer (NEW) ────────────────────────────────────────────────────┤
      │  - cycle detection (DFS)                                       │
      │  - entry point identification (in-degree = 0)                  │
      │  - layer assignment (entry → api → service → data → config)   │
      │  - external dep grouping                                        │
      │                                                                 │
      ▼                                                                 │
UniversalContextGraphPanel (NEW React panel) ◄──────────────────────────┘
      │  - D3 force-directed graph (same engine as knowledge graph)
      │  - Three views: File · Package · Symbol
      │  - Layer filter, language filter, depth control
      │  - Entry point highlighting, cycle warnings
      │  - Click-to-inspect: imports/exported-by per node
      └─ Triggered by: workspace open + index complete + manual refresh
```

---

## Step 1 · Language import patterns

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/universalImportExtractor.ts`
*(New file)*

```typescript
import { readFileSync } from 'fs';
import { relative, extname, dirname, join, basename } from 'path';

export type ImportEdge = {
  fromFile: string;       // relative path of the importing file
  toModule: string;       // raw import string as written
  resolvedFile: string | null;  // resolved relative path if internal
  isExternal: boolean;    // true = npm/pip/maven package, not a local file
  edgeType: 'import' | 'require' | 'include' | 'use' | 'from_import';
};

export type FileNode = {
  filePath: string;       // relative path
  language: string;
  nodeType: NodeType;
  layer: ArchLayer;
  isEntryPoint: boolean;
  exportCount: number;
  importCount: number;
};

export type NodeType =
  | 'entry'      // main.py, index.ts, App.tsx, Application.java
  | 'router'     // routes/, controllers/
  | 'controller'
  | 'service'
  | 'middleware'
  | 'model'
  | 'repository'
  | 'schema'
  | 'util'
  | 'config'
  | 'test'
  | 'external'
  | 'unknown'
  ;

export type ArchLayer = 'entry' | 'api' | 'service' | 'data' | 'config' | 'external' | 'test';

// ── Import extraction regex patterns per language ─────────────────────────────

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  TypeScript: [
    /(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
    /(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    /(?:^|\n)\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
    /(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,  // dynamic import
  ],
  JavaScript: [
    /(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
    /(?:^|\n)\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
    /(?:^|\n)\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm,
  ],
  Python: [
    /(?:^|\n)\s*from\s+([\w.]+)\s+import/gm,
    /(?:^|\n)\s*import\s+([\w.]+)/gm,
  ],
  Java: [
    /(?:^|\n)\s*import\s+([\w.]+)\s*;/gm,
  ],
  Kotlin: [
    /(?:^|\n)\s*import\s+([\w.]+)/gm,
  ],
  Go: [
    /import\s+"([^"]+)"/gm,
    /import\s+\w+\s+"([^"]+)"/gm,
    /"([^"]+)"/gm,  // within import() blocks — applied only inside import blocks
  ],
  Rust: [
    /(?:^|\n)\s*use\s+([\w:]+)/gm,
    /(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm,
  ],
  'C#': [
    /(?:^|\n)\s*using\s+([\w.]+)\s*;/gm,
  ],
  'C++': [
    /(?:^|\n)\s*#include\s+[<"]([^>"]+)[>"]/gm,
  ],
  C: [
    /(?:^|\n)\s*#include\s+[<"]([^>"]+)[>"]/gm,
  ],
  Ruby: [
    /(?:^|\n)\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm,
  ],
  PHP: [
    /(?:^|\n)\s*use\s+([\w\\]+)\s*;/gm,
    /(?:^|\n)\s*require(?:_once)?\s*['"]([^'"]+)['"]/gm,
    /(?:^|\n)\s*include(?:_once)?\s*['"]([^'"]+)['"]/gm,
  ],
};

// Stdlib / built-in modules that are never "external dependencies"
const STDLIB_PREFIXES: Record<string, string[]> = {
  Python: ['os', 'sys', 'json', 'math', 're', 'datetime', 'collections', 'typing',
           'pathlib', 'logging', 'subprocess', 'threading', 'asyncio', 'abc',
           'functools', 'itertools', 'copy', 'io', 'time', 'random', 'struct',
           'hashlib', 'base64', 'urllib', 'http', 'socket', 'enum', 'dataclasses'],
  Java: ['java.', 'javax.', 'sun.', 'com.sun.'],
  'C#': ['System.', 'Microsoft.', 'Windows.'],
  Go: ['fmt', 'os', 'io', 'net', 'math', 'sort', 'sync', 'time', 'strings',
       'strconv', 'bytes', 'errors', 'context', 'log', 'path', 'runtime',
       'reflect', 'encoding', 'crypto', 'testing', 'bufio', 'unicode'],
  Rust: ['std::', 'core::', 'alloc::'],
  'C++': ['iostream', 'string', 'vector', 'map', 'set', 'algorithm', 'memory',
          'utility', 'functional', 'stdexcept', 'cassert', 'cstring', 'cstdlib',
          'cstdio', 'cmath', 'chrono', 'thread', 'mutex', 'condition_variable'],
};

function isStdlib(modulePath: string, language: string): boolean {
  const prefixes = STDLIB_PREFIXES[language] ?? [];
  return prefixes.some(p => modulePath.startsWith(p));
}

function isExternalModule(modulePath: string, language: string): boolean {
  // External: starts with @, or has no relative prefix (./  ../)
  if (language === 'TypeScript' || language === 'JavaScript') {
    return !modulePath.startsWith('.') && !modulePath.startsWith('/');
  }
  if (language === 'Python') {
    return !modulePath.startsWith('.') && !isStdlib(modulePath, language);
  }
  if (language === 'Java') {
    return !isStdlib(modulePath, language);
  }
  if (language === 'Go') {
    return modulePath.includes('.') && !isStdlib(modulePath, language);
  }
  return false;
}

function resolveRelativePath(fromFile: string, modulePath: string, language: string): string | null {
  if (language === 'TypeScript' || language === 'JavaScript') {
    if (!modulePath.startsWith('.')) return null;
    // Try common extensions
    const base = join(dirname(fromFile), modulePath);
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']) {
      const candidate = base.endsWith(ext) ? base : `${base}${ext}`;
      // Return normalized forward-slash path
      return candidate.replace(/\\/g, '/');
    }
  }
  if (language === 'Python') {
    if (!modulePath.startsWith('.')) return null;
    const dots = modulePath.match(/^\.+/)?.[0].length ?? 0;
    const modPart = modulePath.slice(dots).replace(/\./g, '/');
    let base = dirname(fromFile);
    for (let i = 1; i < dots; i++) base = dirname(base);
    return join(base, modPart + '.py').replace(/\\/g, '/');
  }
  return null;
}

export function extractImports(
  filePath: string,        // absolute path
  content: string,
  language: string,
  workspaceRoot: string,
): ImportEdge[] {
  const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/');
  const patterns = IMPORT_PATTERNS[language] ?? [];
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const raw = match[1]?.trim();
      if (!raw || raw.length < 2) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);

      const external = isExternalModule(raw, language);
      const resolvedFile = external ? null : resolveRelativePath(relPath, raw, language);

      edges.push({
        fromFile: relPath,
        toModule: raw,
        resolvedFile,
        isExternal: external,
        edgeType: pattern.source.includes('require') ? 'require'
          : pattern.source.includes('include') ? 'include'
          : 'import',
      });
    }
  }

  return edges;
}
```

---

## Step 2 · Node type classifier

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/universalNodeClassifier.ts`
*(New file)*

```typescript
import { basename, dirname } from 'path';
import type { NodeType, ArchLayer } from './universalImportExtractor.js';

type ClassifierRule = {
  test: (filePath: string, content: string) => boolean;
  nodeType: NodeType;
  layer: ArchLayer;
};

const RULES: ClassifierRule[] = [
  // Entry points — files that are the root of execution
  {
    test: (p, c) => /(?:^|[/\\])(main|index|app|server|application)\.[a-z]+$/.test(p)
      && !/test|spec|mock/i.test(p),
    nodeType: 'entry', layer: 'entry',
  },
  // Test files
  {
    test: (p) => /[\./](?:test|spec|e2e)\.[a-z]+$/.test(p) || /\/__tests__\//.test(p),
    nodeType: 'test', layer: 'test',
  },
  // Controllers / routes (API layer)
  {
    test: (p, c) => /[/\\](?:controllers?|routes?|handlers?|endpoints?)[/\\]/.test(p)
      || /[/\\]\w+\.(?:controller|route|handler|router)\.[a-z]+$/.test(p)
      || /@(?:RestController|Controller|GetMapping|PostMapping|RequestMapping)/.test(c),
    nodeType: 'controller', layer: 'api',
  },
  // Services / business logic
  {
    test: (p, c) => /[/\\](?:services?|business|usecases?|domain)[/\\]/.test(p)
      || /[/\\]\w+\.service\.[a-z]+$/.test(p)
      || /@(?:Service|Injectable|Component)/.test(c),
    nodeType: 'service', layer: 'service',
  },
  // Middleware
  {
    test: (p) => /[/\\](?:middleware|interceptors?)[/\\]/.test(p)
      || /[/\\]\w+\.middleware\.[a-z]+$/.test(p),
    nodeType: 'middleware', layer: 'service',
  },
  // Models / entities / schemas
  {
    test: (p, c) => /[/\\](?:models?|entities|schemas?|domain)[/\\]/.test(p)
      || /[/\\]\w+\.(?:model|entity|schema)\.[a-z]+$/.test(p)
      || /@(?:Entity|Table|Document|Schema|Model)/.test(c),
    nodeType: 'model', layer: 'data',
  },
  // Repositories / DAOs
  {
    test: (p, c) => /[/\\](?:repositories?|daos?|stores?)[/\\]/.test(p)
      || /[/\\]\w+\.(?:repository|dao|store)\.[a-z]+$/.test(p)
      || /@(?:Repository|Dao)/.test(c),
    nodeType: 'repository', layer: 'data',
  },
  // Config files
  {
    test: (p) => /[/\\](?:config|configuration|settings)[/\\]/.test(p)
      || /[/\\]\w+\.(?:config|cfg|settings|env)\.[a-z]+$/.test(p)
      || /(?:^|[/\\])(?:\.env|config)\.[a-z]+$/.test(p),
    nodeType: 'config', layer: 'config',
  },
  // React hooks
  {
    test: (p) => /[/\\]hooks?[/\\]/.test(p) || /[/\\]use[A-Z]\w+\.[a-z]+$/.test(p),
    nodeType: 'util', layer: 'service',
  },
  // Utilities / helpers
  {
    test: (p) => /[/\\](?:utils?|helpers?|lib|common|shared)[/\\]/.test(p)
      || /[/\\]\w+\.(?:utils?|helpers?)\.[a-z]+$/.test(p),
    nodeType: 'util', layer: 'service',
  },
];

export function classifyNode(filePath: string, content: string): { nodeType: NodeType; layer: ArchLayer } {
  for (const rule of RULES) {
    if (rule.test(filePath, content)) {
      return { nodeType: rule.nodeType, layer: rule.layer };
    }
  }
  return { nodeType: 'unknown', layer: 'service' };
}

export function isEntryPoint(filePath: string, content: string, inDegree: number): boolean {
  // An entry point has no other file importing it (in-degree = 0) AND
  // its filename matches a typical entry pattern
  const name = basename(filePath).replace(/\.[^.]+$/, '').toLowerCase();
  const entryNames = new Set(['main', 'index', 'app', 'server', 'application', 'program',
                               '__main__', 'manage', 'wsgi', 'asgi', 'bootstrap']);
  return inDegree === 0 && (entryNames.has(name) || /^index\b/.test(name));
}
```

---

## Step 3 · Graph analyzer (cycles + metrics)

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/universalGraphAnalyzer.ts`
*(New file)*

```typescript
import type { ImportEdge, FileNode } from './universalImportExtractor.js';

export type GraphMetrics = {
  totalNodes: number;
  totalEdges: number;
  entryPoints: string[];
  cycleCount: number;
  cycles: string[][];         // each cycle as array of file paths
  maxDepth: number;           // longest path from any entry point
  orphanFiles: string[];      // files with no imports and not imported by anything
  hotFiles: string[];         // files imported by the most others (top 5)
  externalDeps: Map<string, number>;  // external dep → how many files import it
};

/** Tarjan's SCC for cycle detection. */
export function detectCycles(
  nodes: string[],
  edges: ImportEdge[],
): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (e.resolvedFile) {
      adj.get(e.fromFile)?.push(e.resolvedFile);
    }
  }

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const SCCs: string[][] = [];
  let counter = 0;

  function strongConnect(v: string) {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of (adj.get(v) ?? [])) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) SCCs.push(scc); // only cycles (size > 1)
    }
  }

  for (const n of nodes) {
    if (!index.has(n)) strongConnect(n);
  }

  return SCCs;
}

export function computeMetrics(
  nodes: FileNode[],
  edges: ImportEdge[],
): GraphMetrics {
  const nodeSet = new Set(nodes.map(n => n.filePath));
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const externalDeps = new Map<string, number>();

  for (const n of nodes) { inDegree.set(n.filePath, 0); outDegree.set(n.filePath, 0); }

  for (const e of edges) {
    if (e.isExternal) {
      externalDeps.set(e.toModule, (externalDeps.get(e.toModule) ?? 0) + 1);
    } else if (e.resolvedFile && nodeSet.has(e.resolvedFile)) {
      inDegree.set(e.resolvedFile, (inDegree.get(e.resolvedFile) ?? 0) + 1);
      outDegree.set(e.fromFile, (outDegree.get(e.fromFile) ?? 0) + 1);
    }
  }

  const entryPoints = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([f]) => f);

  const orphanFiles = nodes
    .filter(n => (inDegree.get(n.filePath) ?? 0) === 0 && (outDegree.get(n.filePath) ?? 0) === 0)
    .map(n => n.filePath);

  const hotFiles = [...inDegree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);

  const cycles = detectCycles(nodes.map(n => n.filePath), edges);

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    entryPoints,
    cycleCount: cycles.length,
    cycles,
    maxDepth: 0, // BFS from entry points — computed separately if needed
    orphanFiles,
    hotFiles,
    externalDeps,
  };
}
```

---

## Step 4 · SQLite schema — new tables

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts`

Append to `SCHEMA` constant (after existing STaaS tables):

```sql
-- ── Universal Context Graph ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ucg_file_nodes (
  workspace_hash  TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  language        TEXT NOT NULL,
  node_type       TEXT NOT NULL,   -- entry|controller|service|model|config|test|unknown
  arch_layer      TEXT NOT NULL,   -- entry|api|service|data|config|external|test
  is_entry_point  INTEGER NOT NULL DEFAULT 0,
  import_count    INTEGER NOT NULL DEFAULT 0,
  imported_by_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_hash, file_path)
);
CREATE INDEX IF NOT EXISTS idx_ucg_nodes_layer ON ucg_file_nodes(workspace_hash, arch_layer);

CREATE TABLE IF NOT EXISTS ucg_import_edges (
  workspace_hash  TEXT NOT NULL,
  from_file       TEXT NOT NULL,
  to_module       TEXT NOT NULL,   -- raw import string
  resolved_file   TEXT,            -- null for external deps
  is_external     INTEGER NOT NULL DEFAULT 0,
  edge_type       TEXT NOT NULL,   -- import|require|include|use
  PRIMARY KEY (workspace_hash, from_file, to_module)
);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_from ON ucg_import_edges(workspace_hash, from_file);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_to   ON ucg_import_edges(workspace_hash, resolved_file);
CREATE INDEX IF NOT EXISTS idx_ucg_edges_ext  ON ucg_import_edges(workspace_hash, is_external);

CREATE TABLE IF NOT EXISTS ucg_graph_metrics (
  workspace_hash  TEXT PRIMARY KEY,
  total_nodes     INTEGER NOT NULL DEFAULT 0,
  total_edges     INTEGER NOT NULL DEFAULT 0,
  entry_count     INTEGER NOT NULL DEFAULT 0,
  cycle_count     INTEGER NOT NULL DEFAULT 0,
  cycles_json     TEXT NOT NULL DEFAULT '[]',
  hot_files_json  TEXT NOT NULL DEFAULT '[]',
  ext_deps_json   TEXT NOT NULL DEFAULT '{}',
  computed_at     INTEGER NOT NULL
);
```

Add DB methods:
```typescript
// Bulk upsert file nodes for a workspace
async replaceUCGNodes(workspaceHash: string, nodes: UCGFileNode[]): Promise<void>

// Bulk upsert import edges
async replaceUCGEdges(workspaceHash: string, edges: UCGImportEdge[]): Promise<void>

// Store graph metrics
async upsertUCGMetrics(workspaceHash: string, metrics: UCGGraphMetrics): Promise<void>

// Query: get full graph data for the visual panel
async getUCGGraph(workspaceHash: string): Promise<{nodes: UCGFileNode[]; edges: UCGImportEdge[]}> 

// Query: get metrics
async getUCGMetrics(workspaceHash: string): Promise<UCGGraphMetrics | null>
```

---

## Step 5 · Wire into `_scanWorkspace()`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

Add imports:
```typescript
import { extractImports } from './universalImportExtractor.js';
import { classifyNode, isEntryPoint } from './universalNodeClassifier.js';
import { computeMetrics } from './universalGraphAnalyzer.js';
```

After the existing STaaS polyglot try/catch block, add:
```typescript
// ── Universal Context Graph ──────────────────────────────────────────────────
try {
  const ucgStart = Date.now();
  const allNodes: UCGFileNode[] = [];
  const allEdges: UCGImportEdge[] = [];

  // Process every indexed file
  for (const fileMeta of scan.fileMeta) {
    const { filePath, language } = fileMeta;
    if (!language || language === 'Unknown' || language === 'Markdown') continue;

    let content = '';
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

    const relPath = relative(workspaceRoot, filePath).replace(/\\/g, '/');
    const classification = classifyNode(relPath, content);
    const imports = extractImports(filePath, content, language, workspaceRoot);

    allNodes.push({
      workspaceHash: hash,
      filePath: relPath,
      language,
      nodeType: classification.nodeType,
      archLayer: classification.layer,
      isEntryPoint: false,  // computed after in-degree is known
      importCount: imports.filter(e => !e.isExternal).length,
      importedByCount: 0,   // filled by computeMetrics
    });

    for (const imp of imports) {
      allEdges.push({
        workspaceHash: hash,
        fromFile: relPath,
        toModule: imp.toModule,
        resolvedFile: imp.resolvedFile,
        isExternal: imp.isExternal,
        edgeType: imp.edgeType,
      });
    }
  }

  // Compute metrics (cycles, entry points, hot files)
  const metrics = computeMetrics(allNodes, allEdges);

  // Mark entry points
  for (const node of allNodes) {
    const inDeg = allEdges.filter(e => e.resolvedFile === node.filePath).length;
    node.isEntryPoint = isEntryPoint(node.filePath, '', inDeg);
    node.importedByCount = inDeg;
  }

  // Persist to DB
  await this._db.replaceUCGNodes(hash, allNodes);
  await this._db.replaceUCGEdges(hash, allEdges);
  await this._db.upsertUCGMetrics(hash, {
    workspaceHash: hash,
    totalNodes: metrics.totalNodes,
    totalEdges: metrics.totalEdges,
    entryCount: metrics.entryPoints.length,
    cycleCount: metrics.cycleCount,
    cyclesJson: JSON.stringify(metrics.cycles),
    hotFilesJson: JSON.stringify(metrics.hotFiles),
    extDepsJson: JSON.stringify(Object.fromEntries(metrics.externalDeps)),
    computedAt: Date.now(),
  });

  this._metricsService.capture('UCG Indexed', {
    nodeCount: allNodes.length,
    edgeCount: allEdges.length,
    cycleCount: metrics.cycleCount,
    durationMs: Date.now() - ucgStart,
  });

  // Fire event so the panel refreshes
  this._onKGUpdated?.fire({ workspaceRoot, delta: null });
} catch (err) {
  console.error('[UniversalContextGraph] Indexing failed:', err);
}
```

Add to `IRepoIntelligenceMainService`:
```typescript
getUCGGraph(workspaceRoot: string): Promise<{nodes: UCGFileNode[]; edges: UCGImportEdge[]} | null>;
getUCGMetrics(workspaceRoot: string): Promise<UCGGraphMetrics | null>;
```

---

## Step 6 · React panel

**File:** `src/vs/workbench/contrib/trove/browser/react/src/context-graph-tsx/UniversalContextGraphPanel.tsx`
*(New file — follows the exact same pattern as `KnowledgeGraphPanel.tsx`)*

The panel uses the same `ForceGraph.tsx` engine from the knowledge graph, with:
- **Three view modes**: File (one node per file), Package (one node per directory), Symbol (one node per exported symbol)
- **Import edges** between nodes
- **Node size** proportional to `importedByCount` (most-imported = largest)
- **Cycle indicator**: nodes in detected cycles get an amber dashed outline
- **Entry point indicator**: entry nodes get a coral solid outer ring
- **Language filter**: toggle by language (TypeScript, Python, Java, Go, etc.)
- **Layer filter**: toggle by arch layer (entry, api, service, data, config, external)
- **Depth slider**: show only nodes within N hops of selected node
- **Metrics bar**: total files · import edges · cycles · entry points · external deps

### View mode: Package

When in "Package" view, group files by their directory. A package node's radius is
proportional to the file count. Edges represent cross-package imports. This is the
best view for large repos (100+ files).

```typescript
function buildPackageGraph(nodes: UCGFileNode[], edges: UCGImportEdge[]) {
  // Group nodes by first 2 directory levels
  const pkgs = new Map<string, UCGFileNode[]>();
  for (const n of nodes) {
    const parts = n.filePath.split('/');
    const pkg = parts.slice(0, Math.min(2, parts.length - 1)).join('/') || '.';
    if (!pkgs.has(pkg)) pkgs.set(pkg, []);
    pkgs.get(pkg)!.push(n);
  }
  // Build package nodes + cross-package edges
  // ...
}
```

### Panel registration

**File:** `browser/sidebarPane.ts` — follow the same `ViewPane` registration pattern
used for `KnowledgeGraphViewPane`.

**Command:** `trove.openContextGraph` in `trove.contribution.ts`.

---

## Step 7 · Language support matrix

| Language | Import extraction | Node classification | Cycle detection |
|---|---|---|---|
| TypeScript / TSX | ✓ Full (import, require, dynamic) | ✓ Full | ✓ |
| JavaScript / JSX | ✓ Full | ✓ Full | ✓ |
| Python | ✓ Full (import, from…import) | ✓ Full | ✓ |
| Java | ✓ Full (import statements) | ✓ Full (@annotations) | ✓ |
| Kotlin | ✓ Full | ✓ Partial | ✓ |
| Go | ✓ Full | ✓ Partial | ✓ |
| Rust | ✓ Full (use, mod) | ✓ Partial | ✓ |
| C# | ✓ Full (using) | ✓ Partial | ✓ |
| C / C++ | ✓ Partial (#include) | ○ Path-based | ✓ |
| Ruby | ✓ Full (require, require_relative) | ○ Path-based | ✓ |
| PHP | ✓ Full (use, require, include) | ○ Path-based | ✓ |

---

## Step 8 · Execution order

```
1. universalImportExtractor.ts    NEW — import regex patterns for 11 languages
2. universalNodeClassifier.ts     NEW — file → {nodeType, layer} rules
3. universalGraphAnalyzer.ts      NEW — cycle detection + metrics
4. repoIntelligenceDb.ts          EDIT — 3 new tables + 4 new methods, SCHEMA_VERSION bump
5. repoIntelligenceService.impl.ts EDIT — wire UCG pipeline after STaaS block
6. repoIntelligenceTypes.ts       EDIT — add getUCGGraph/getUCGMetrics to IRepoIntelligenceMainService
7. [COMPILE CHECK]
8. react/context-graph-tsx/UniversalContextGraphPanel.tsx  NEW — panel UI
9. react/context-graph-tsx/index.tsx                       NEW — mountFnGenerator entry
10. sidebarPane.ts                EDIT — register UniversalContextGraphViewPane
11. trove.contribution.ts         EDIT — register openContextGraph command
12. [REBUILD + TEST — open any repo, verify panel shows file graph]
```

---

## What you get for any repo

```
Any TypeScript repo  →  File import graph + component/service/model layers
Any Python project   →  Module dependency graph + FastAPI/Django/Flask detection
Any Java project     →  Package import graph + Spring Boot layer classification
Any Go module        →  Package dependency graph
Any Rust crate       →  Module tree (mod declarations)
Any mixed-language   →  Combined graph with per-language color coding

Automatic insights:
  • Entry points identified (files with in-degree = 0, entry-like names)
  • Import cycles flagged with file list
  • Most-imported files highlighted (architectural "load-bearing" code)
  • External dependency usage counts
  • Orphan files (not imported by anything, not importing anything)
  • Architecture layers inferred from naming conventions + annotations
```

*Works on the workspace immediately after indexing — no repo-specific configuration needed.*
