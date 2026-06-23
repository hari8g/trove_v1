# STaaS ↔ Trove v1 — Detailed Integration Implementation Plan
> **Cursor AI–executable document** · Generated from live clone of `hari8g/trove_v1`
> All file paths are relative to the repository root unless prefixed with `src/`.
> Every step references the exact existing file it extends, with the precise location of each edit.

---

## 0. Architectural Anchors (Read Before Coding)

Before executing any step, understand these five integration laws that apply to every change:

**LAW 1 — Electron-main owns disk/FS work.** Every new indexer that reads files must live in
`src/vs/workbench/contrib/trove/electron-main/repoIntelligence/`. It runs in the Node.js main
process with full `fs` access. The browser process accesses results only via the `IRepoIntelligenceService`
proxy channel, never by direct FS calls.

**LAW 2 — SQLite is the single source of truth.** All indexed data (service graph, Maven deps,
K8s topology, etc.) is stored in `trove-repo-intelligence.db` via `RepoIntelligenceDb`. Add a new
table in the `SCHEMA` constant. Bump `SCHEMA_VERSION`. Add an idempotent `ALTER TABLE` migration
in `_migrate()`. Mirror every new table with query methods on the `RepoIntelligenceDb` class.

**LAW 3 — WorkspaceProfile is the context injection bus.** To surface indexed data to the LLM,
add optional fields to `WorkspaceProfile` in `repoIntelligenceTypes.ts`, populate them in
`RepoIntelligenceMainService._scanWorkspace()`, and render them in `serializeWorkspaceProfileForPrompt()`
in `prompts.ts` inside `<repository_context>`.

**LAW 4 — Tools follow a 3-file registration pattern.** Adding a new built-in tool requires exactly
three edits: (a) add the call-params + result types to `BuiltinToolCallParams`/`BuiltinToolResultType`
in `toolsServiceTypes.ts`; (b) add the `builtinTools` entry (name + description + params) in `prompts.ts`;
(c) implement `validateParams[toolName]`, `callTool[toolName]`, and `stringOfResult[toolName]` in
`toolsService.ts`.

**LAW 5 — `xml2js` is already installed.** Maven POM parsing uses `xml2js` (`^0.5.0` in
`package.json`). No new packages are needed for Phases α–β. Phase γ Terraform parsing uses regex.
K8s YAML parsing uses `js-yaml` (add to package.json; confirmed not present).

---

## Key File Reference Map

| Purpose | File |
|---|---|
| SQLite schema + DB methods | `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts` |
| Workspace scan + profile build | `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts` |
| Symbol extraction patterns | `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/codeChunker.ts` |
| File system scanner | `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/workspaceScanner.ts` |
| WorkspaceProfile type | `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts` |
| IRepoIntelligenceMainService interface | `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts` |
| Tool type registration | `src/vs/workbench/contrib/trove/common/toolsServiceTypes.ts` |
| Tool prompt definitions | `src/vs/workbench/contrib/trove/common/prompt/prompts.ts` |
| Tool implementation | `src/vs/workbench/contrib/trove/browser/toolsService.ts` |
| System message + context injection | `src/vs/workbench/contrib/trove/common/prompt/prompts.ts` |
| Service registration | `src/vs/workbench/contrib/trove/browser/trove.contribution.ts` |
| RIAF prompts | `src/vs/workbench/contrib/trove/common/riaf/riafPrompts.ts` |

---

## Phase α — Polyglot Indexing + Service Mesh + API Contracts

**Goal:** Make the agent aware of all 25+ Spring Boot services, their inter-dependencies, and the
frontend ↔ backend API contract surface. This is the highest-value phase — without it the agent is
blind to 90% of the STaaS codebase.

**Steps in this phase:** α-1 through α-13.

---

### α-1 · Extend the SQLite Schema — 5 new tables

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts`

**Edit 1a — Bump schema version.** Locate the constant at line 11:
```
const SCHEMA_VERSION = 2;
```
Change it to:
```typescript
const SCHEMA_VERSION = 3;
```

**Edit 1b — Append new tables to SCHEMA constant.** After the last `CREATE INDEX` statement inside
the `SCHEMA` template literal (before the closing backtick), add:

```sql
-- ── STaaS polyglot extensions ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS java_spring_endpoints (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  http_method       TEXT NOT NULL,   -- GET, POST, PUT, DELETE, PATCH
  path_pattern      TEXT NOT NULL,   -- e.g. /order/{id}
  controller_class  TEXT NOT NULL,
  handler_method    TEXT NOT NULL,
  request_dto       TEXT,            -- Java class name of @RequestBody
  response_dto      TEXT,            -- return type class name
  PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON java_spring_endpoints(workspace_hash, path_pattern);
CREATE INDEX IF NOT EXISTS idx_endpoints_service ON java_spring_endpoints(workspace_hash, service_name);

CREATE TABLE IF NOT EXISTS feign_clients (
  workspace_hash    TEXT NOT NULL,
  caller_service    TEXT NOT NULL,   -- service containing the @FeignClient
  target_service    TEXT NOT NULL,   -- value= / name= on @FeignClient
  interface_name    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feign_caller ON feign_clients(workspace_hash, caller_service);
CREATE INDEX IF NOT EXISTS idx_feign_target ON feign_clients(workspace_hash, target_service);

CREATE TABLE IF NOT EXISTS maven_dependencies (
  workspace_hash    TEXT NOT NULL,
  consumer_path     TEXT NOT NULL,   -- relative pom.xml path of the consumer
  group_id          TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  version           TEXT,
  scope             TEXT,            -- compile, test, provided, runtime
  PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_maven_artifact ON maven_dependencies(workspace_hash, artifact_id);
CREATE INDEX IF NOT EXISTS idx_maven_consumer ON maven_dependencies(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS k8s_resources (
  workspace_hash    TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  kind              TEXT NOT NULL,   -- Deployment, Service, Ingress, ConfigMap, Secret
  name              TEXT NOT NULL,
  namespace         TEXT,
  env_label         TEXT,            -- dev / qa / stage / prod derived from path
  image_tag         TEXT,            -- container image if Deployment
  PRIMARY KEY (workspace_hash, file_path, kind, name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_k8s_kind ON k8s_resources(workspace_hash, kind);
CREATE INDEX IF NOT EXISTS idx_k8s_name ON k8s_resources(workspace_hash, name);

CREATE TABLE IF NOT EXISTS gateway_routes (
  workspace_hash    TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  path_predicate    TEXT NOT NULL,   -- e.g. /order/**
  target_service    TEXT NOT NULL,   -- lb://staas-order-management
  strip_prefix      INTEGER,
  PRIMARY KEY (workspace_hash, route_id),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_routes_path ON gateway_routes(workspace_hash, path_predicate);
```

**Edit 1c — Add migration guard in `_migrate()`.** Inside the `_migrate()` method (after the last
`_ensureFtsTable` call, before the final `PRAGMA user_version` line), add:

```typescript
// v3 migration: STaaS polyglot tables
await this._ensureTable(db, 'java_spring_endpoints',
  `CREATE TABLE IF NOT EXISTS java_spring_endpoints (
    workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
    file_path TEXT NOT NULL, http_method TEXT NOT NULL, path_pattern TEXT NOT NULL,
    controller_class TEXT NOT NULL, handler_method TEXT NOT NULL,
    request_dto TEXT, response_dto TEXT,
    PRIMARY KEY (workspace_hash, service_name, http_method, path_pattern)
  )`);
await this._ensureTable(db, 'feign_clients',
  `CREATE TABLE IF NOT EXISTS feign_clients (
    workspace_hash TEXT NOT NULL, caller_service TEXT NOT NULL,
    target_service TEXT NOT NULL, interface_name TEXT NOT NULL, file_path TEXT NOT NULL,
    PRIMARY KEY (workspace_hash, caller_service, target_service, interface_name)
  )`);
await this._ensureTable(db, 'maven_dependencies',
  `CREATE TABLE IF NOT EXISTS maven_dependencies (
    workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
    group_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version TEXT, scope TEXT,
    PRIMARY KEY (workspace_hash, consumer_path, group_id, artifact_id)
  )`);
await this._ensureTable(db, 'k8s_resources',
  `CREATE TABLE IF NOT EXISTS k8s_resources (
    workspace_hash TEXT NOT NULL, file_path TEXT NOT NULL,
    kind TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT,
    env_label TEXT, image_tag TEXT,
    PRIMARY KEY (workspace_hash, file_path, kind, name)
  )`);
await this._ensureTable(db, 'gateway_routes',
  `CREATE TABLE IF NOT EXISTS gateway_routes (
    workspace_hash TEXT NOT NULL, route_id TEXT NOT NULL,
    path_predicate TEXT NOT NULL, target_service TEXT NOT NULL, strip_prefix INTEGER,
    PRIMARY KEY (workspace_hash, route_id)
  )`);
```

**Edit 1d — Add `_ensureTable` helper to `RepoIntelligenceDb` class:**

```typescript
private async _ensureTable(db: Database, tableName: string, createSql: string): Promise<void> {
  const exists = await this._tableExists(db, tableName);
  if (!exists) {
    await this._exec(db, createSql);
  }
}
```

---

### α-2 · Add DB Query/Upsert Methods to `RepoIntelligenceDb`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts`

Append the following six public methods before the closing `}` of the `RepoIntelligenceDb` class.
Follow the exact same `_run`/`_all`/`_get` patterns already used by `upsertProfile`, `replaceChunks`,
and `searchSymbols`.

```typescript
// ── α methods ────────────────────────────────────────────────────────────

async replaceSpringEndpoints(workspaceHash: string, endpoints: SpringEndpoint[]): Promise<void> {
  await this._run(`DELETE FROM java_spring_endpoints WHERE workspace_hash = ?`, [workspaceHash]);
  for (const ep of endpoints) {
    await this._run(
      `INSERT OR REPLACE INTO java_spring_endpoints
        (workspace_hash, service_name, file_path, http_method, path_pattern,
         controller_class, handler_method, request_dto, response_dto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspaceHash, ep.serviceName, ep.filePath, ep.httpMethod, ep.pathPattern,
       ep.controllerClass, ep.handlerMethod, ep.requestDto ?? null, ep.responseDto ?? null],
    );
  }
}

async getSpringEndpoints(workspaceHash: string): Promise<SpringEndpoint[]> {
  type Row = { service_name: string; file_path: string; http_method: string;
    path_pattern: string; controller_class: string; handler_method: string;
    request_dto: string | null; response_dto: string | null };
  const rows = await this._all<Row>(
    `SELECT service_name, file_path, http_method, path_pattern,
            controller_class, handler_method, request_dto, response_dto
     FROM java_spring_endpoints WHERE workspace_hash = ? ORDER BY path_pattern`,
    [workspaceHash],
  );
  return rows.map(r => ({
    serviceName: r.service_name, filePath: r.file_path, httpMethod: r.http_method,
    pathPattern: r.path_pattern, controllerClass: r.controller_class,
    handlerMethod: r.handler_method, requestDto: r.request_dto ?? undefined,
    responseDto: r.response_dto ?? undefined,
  }));
}

async replaceFeignClients(workspaceHash: string, clients: FeignClientEdge[]): Promise<void> {
  await this._run(`DELETE FROM feign_clients WHERE workspace_hash = ?`, [workspaceHash]);
  for (const c of clients) {
    await this._run(
      `INSERT OR REPLACE INTO feign_clients
        (workspace_hash, caller_service, target_service, interface_name, file_path)
       VALUES (?, ?, ?, ?, ?)`,
      [workspaceHash, c.callerService, c.targetService, c.interfaceName, c.filePath],
    );
  }
}

async getFeignClients(workspaceHash: string): Promise<FeignClientEdge[]> {
  type Row = { caller_service: string; target_service: string;
    interface_name: string; file_path: string };
  const rows = await this._all<Row>(
    `SELECT caller_service, target_service, interface_name, file_path
     FROM feign_clients WHERE workspace_hash = ?`,
    [workspaceHash],
  );
  return rows.map(r => ({
    callerService: r.caller_service, targetService: r.target_service,
    interfaceName: r.interface_name, filePath: r.file_path,
  }));
}

async replaceMavenDependencies(workspaceHash: string, deps: MavenDep[]): Promise<void> {
  await this._run(`DELETE FROM maven_dependencies WHERE workspace_hash = ?`, [workspaceHash]);
  for (const d of deps) {
    await this._run(
      `INSERT OR REPLACE INTO maven_dependencies
        (workspace_hash, consumer_path, group_id, artifact_id, version, scope)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [workspaceHash, d.consumerPath, d.groupId, d.artifactId, d.version ?? null, d.scope ?? null],
    );
  }
}

async getMavenConsumers(workspaceHash: string, artifactId: string): Promise<MavenDep[]> {
  type Row = { consumer_path: string; group_id: string; artifact_id: string;
    version: string | null; scope: string | null };
  const rows = await this._all<Row>(
    `SELECT consumer_path, group_id, artifact_id, version, scope
     FROM maven_dependencies WHERE workspace_hash = ? AND artifact_id = ?`,
    [workspaceHash, artifactId],
  );
  return rows.map(r => ({
    consumerPath: r.consumer_path, groupId: r.group_id, artifactId: r.artifact_id,
    version: r.version ?? undefined, scope: r.scope ?? undefined,
  }));
}

async replaceGatewayRoutes(workspaceHash: string, routes: GatewayRoute[]): Promise<void> {
  await this._run(`DELETE FROM gateway_routes WHERE workspace_hash = ?`, [workspaceHash]);
  for (const r of routes) {
    await this._run(
      `INSERT OR REPLACE INTO gateway_routes
        (workspace_hash, route_id, path_predicate, target_service, strip_prefix)
       VALUES (?, ?, ?, ?, ?)`,
      [workspaceHash, r.routeId, r.pathPredicate, r.targetService, r.stripPrefix ? 1 : 0],
    );
  }
}

async getGatewayRoutes(workspaceHash: string): Promise<GatewayRoute[]> {
  type Row = { route_id: string; path_predicate: string; target_service: string; strip_prefix: number };
  const rows = await this._all<Row>(
    `SELECT route_id, path_predicate, target_service, strip_prefix
     FROM gateway_routes WHERE workspace_hash = ?`,
    [workspaceHash],
  );
  return rows.map(r => ({
    routeId: r.route_id, pathPredicate: r.path_predicate,
    targetService: r.target_service, stripPrefix: r.strip_prefix === 1,
  }));
}

async replaceK8sResources(workspaceHash: string, resources: K8sResource[]): Promise<void> {
  await this._run(`DELETE FROM k8s_resources WHERE workspace_hash = ?`, [workspaceHash]);
  for (const r of resources) {
    await this._run(
      `INSERT OR REPLACE INTO k8s_resources
        (workspace_hash, file_path, kind, name, namespace, env_label, image_tag)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceHash, r.filePath, r.kind, r.name,
       r.namespace ?? null, r.envLabel ?? null, r.imageTag ?? null],
    );
  }
}
```

Also add these type declarations **before** the `RepoIntelligenceDb` class definition:

```typescript
export type SpringEndpoint = {
  serviceName: string;
  filePath: string;
  httpMethod: string;
  pathPattern: string;
  controllerClass: string;
  handlerMethod: string;
  requestDto?: string;
  responseDto?: string;
};

export type FeignClientEdge = {
  callerService: string;
  targetService: string;
  interfaceName: string;
  filePath: string;
};

export type MavenDep = {
  consumerPath: string;
  groupId: string;
  artifactId: string;
  version?: string;
  scope?: string;
};

export type GatewayRoute = {
  routeId: string;
  pathPredicate: string;
  targetService: string;
  stripPrefix: boolean;
};

export type K8sResource = {
  filePath: string;
  kind: string;
  name: string;
  namespace?: string;
  envLabel?: string;
  imageTag?: string;
};
```

---

### α-3 · Extend `WorkspaceProfile` with STaaS Context Fields

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts`

Append these optional fields to the existing `WorkspaceProfile` type (after `isStale`):

```typescript
// ── STaaS polyglot context ─────────────────────────────────────────────
/** Detected service topology summary for the active workspace */
serviceTopologySummary?: ServiceTopologySummary | null;
/** Maven artifact impact graph (library → consumer count) */
mavenImpactSummary?: MavenImpactSummary | null;
```

Then add the two supporting types (can go below `WorkspaceProfile`):

```typescript
export type ServiceTopologySummary = {
  /** Total number of Spring Boot microservices detected */
  serviceCount: number;
  /** List of service names detected in this workspace */
  serviceNames: string[];
  /** Gateway route mappings: pathPattern → targetService */
  gatewayRoutes: { pathPattern: string; targetService: string }[];
  /** Feign call edges: caller → [targets] */
  feignEdges: { caller: string; targets: string[] }[];
  /** Total @RestController endpoints indexed */
  totalEndpoints: number;
};

export type MavenImpactSummary = {
  /** Shared library artifact IDs with their consumer counts */
  sharedLibs: { artifactId: string; consumerCount: number }[];
  /** Total pom.xml files indexed */
  pomCount: number;
};
```

Also add the following new method signatures to `IRepoIntelligenceMainService`:

```typescript
getServiceTopology(workspaceRoot: string): Promise<ServiceTopologySummary | null>;
getMavenImpact(workspaceRoot: string, artifactId: string): Promise<string[]>;
resolveApiContract(workspaceRoot: string, httpMethod: string, pathPattern: string): Promise<ApiContractResult | null>;
```

And add:

```typescript
export type ApiContractResult = {
  pathPattern: string;
  httpMethod: string;
  backendService: string;
  controllerClass: string;
  handlerMethod: string;
  requestDto?: string;
  responseDto?: string;
  filePath: string;
};
```

---

### α-4 · Create `JavaSpringIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/javaSpringIndexer.ts`
*(New file — create it)*

This is a pure Node.js FS module (no DI) following the same pattern as `workspaceScanner.ts` and
`codeChunker.ts`. It uses regex-based parsing on `.java` files — not tree-sitter — for consistency
with the existing indexer approach.

```typescript
/*---------------------------------------------------------------------------
 * JavaSpringIndexer — parses @RestController, @FeignClient, and port config
 * from Java/Spring Boot service files. No tree-sitter; regex over .java files.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { FeignClientEdge, SpringEndpoint } from './repoIntelligenceDb.js';

// HTTP method annotations
const HTTP_METHOD_MAP: Record<string, string> = {
  'GetMapping': 'GET',
  'PostMapping': 'POST',
  'PutMapping': 'PUT',
  'DeleteMapping': 'DELETE',
  'PatchMapping': 'PATCH',
};

/** Derives a service name from the workspace root or a spring.application.name property. */
function deriveServiceName(workspaceRoot: string, applicationYmlPath: string | null): string {
  if (applicationYmlPath) {
    try {
      const yml = readFileSync(applicationYmlPath, 'utf8');
      const match = yml.match(/spring:\s*\n\s+application:\s*\n\s+name:\s*([^\n]+)/);
      if (match) return match[1].trim();
    } catch { /* ignore */ }
  }
  return workspaceRoot.split('/').at(-1) ?? 'unknown-service';
}

/** Collect all .java files under a directory, skipping build/target dirs. */
function collectJavaFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 10) return results;
  const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'out', '.gradle']);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collectJavaFiles(full, results, depth + 1);
    else if (entry.endsWith('.java')) results.push(full);
  }
  return results;
}

/** Locate the closest application.yml starting from a service directory. */
function findApplicationYml(serviceDir: string): string | null {
  const candidates = [
    join(serviceDir, 'src', 'main', 'resources', 'application.yml'),
    join(serviceDir, 'src', 'main', 'resources', 'application.yaml'),
    join(serviceDir, 'application.yml'),
  ];
  for (const c of candidates) {
    try { statSync(c); return c; } catch { /* continue */ }
  }
  return null;
}

/** Extract @RequestMapping class-level prefix */
function extractClassLevelPath(source: string): string {
  const match = source.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
  return match ? match[1] : '';
}

/** Extract path from a mapping annotation (GetMapping, PostMapping, etc.) */
function extractMethodPath(annotation: string): string {
  const match = annotation.match(/["']([^"']+)["']/);
  return match ? match[1] : '';
}

export type JavaIndexResult = {
  endpoints: SpringEndpoint[];
  feignClients: FeignClientEdge[];
  serviceName: string;
};

/**
 * Index a single Spring Boot service directory.
 * @param workspaceRoot Absolute path to workspace root (used for relative file paths)
 * @param serviceDir Absolute path to the Spring Boot service (may equal workspaceRoot for flat repos)
 */
export function indexJavaSpringService(workspaceRoot: string, serviceDir: string): JavaIndexResult {
  const appYml = findApplicationYml(serviceDir);
  const serviceName = deriveServiceName(serviceDir, appYml);
  const javaFiles = collectJavaFiles(serviceDir);

  const endpoints: SpringEndpoint[] = [];
  const feignClients: FeignClientEdge[] = [];

  for (const filePath of javaFiles) {
    let source: string;
    try { source = readFileSync(filePath, 'utf8'); } catch { continue; }

    const relPath = relative(workspaceRoot, filePath);

    // ── @FeignClient detection ───────────────────────────────────────────
    const feignMatches = source.matchAll(/@FeignClient\s*\(\s*(?:name\s*=\s*|value\s*=\s*)?["']([^"']+)["']/g);
    for (const m of feignMatches) {
      const targetService = m[1];
      // Extract interface name from "interface <Name>"
      const interfaceMatch = source.match(/public\s+interface\s+(\w+)/);
      const interfaceName = interfaceMatch ? interfaceMatch[1] : relPath.split('/').at(-1)?.replace('.java', '') ?? 'Unknown';
      feignClients.push({ callerService: serviceName, targetService, interfaceName, filePath: relPath });
    }

    // ── @RestController endpoint detection ──────────────────────────────
    if (!/@RestController/.test(source) && !/@Controller/.test(source)) continue;

    // Extract class name
    const classMatch = source.match(/(?:public\s+)?class\s+(\w+)/);
    const controllerClass = classMatch ? classMatch[1] : 'Unknown';

    // Class-level @RequestMapping prefix
    const classPath = extractClassLevelPath(source);

    // Find each method-level mapping annotation
    const methodAnnotationRegex = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(([^)]*)\)/g;
    let methodMatch: RegExpExecArray | null;

    while ((methodMatch = methodAnnotationRegex.exec(source)) !== null) {
      const annotationName = methodMatch[1];
      const annotationBody = methodMatch[2];
      const httpMethod = HTTP_METHOD_MAP[annotationName] ?? 'GET';

      const methodPath = extractMethodPath(annotationBody);
      const fullPath = classPath + (methodPath.startsWith('/') ? methodPath : '/' + methodPath);

      // Find the method name that follows this annotation
      const afterAnnotation = source.slice(methodMatch.index + methodMatch[0].length);
      const handlerMatch = afterAnnotation.match(/\s+(?:public|private|protected)\s+\S+\s+(\w+)\s*\(/);
      const handlerMethod = handlerMatch ? handlerMatch[1] : 'unknown';

      // Extract @RequestBody DTO type
      const paramSection = afterAnnotation.match(/\(([^)]*)\)/)?.[1] ?? '';
      const requestDtoMatch = paramSection.match(/@RequestBody\s+(\w+)/);
      const requestDto = requestDtoMatch ? requestDtoMatch[1] : undefined;

      // Extract return type (simplified: before method name)
      const beforeHandler = source.slice(0, methodMatch.index);
      const returnTypeMatch = beforeHandler.split('\n').at(-1)?.match(/\s+(\w+(?:<[^>]+>)?)\s+\w+\s*\(/) ?? null;
      const responseDto = returnTypeMatch ? returnTypeMatch[1] : undefined;

      endpoints.push({
        serviceName, filePath: relPath, httpMethod,
        pathPattern: fullPath || '/',
        controllerClass, handlerMethod,
        requestDto, responseDto,
      });
    }
  }

  return { endpoints, feignClients, serviceName };
}

/**
 * Index all Spring Boot services found within a workspace root.
 * Detects service directories by looking for pom.xml files with spring-boot in them.
 */
export function indexAllSpringServices(workspaceRoot: string): JavaIndexResult {
  const allEndpoints: SpringEndpoint[] = [];
  const allFeignClients: FeignClientEdge[] = [];
  const serviceNames: string[] = [];

  // Find all pom.xml files
  const pomFiles: string[] = [];
  function findPoms(dir: string, depth = 0) {
    if (depth > 5) return;
    const SKIP = new Set(['node_modules', '.git', 'target', 'build', '.gradle']);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) findPoms(full, depth + 1);
      else if (entry === 'pom.xml') pomFiles.push(full);
    }
  }
  findPoms(workspaceRoot);

  // For each pom.xml that has spring-boot, treat its parent directory as a service
  const processedDirs = new Set<string>();
  for (const pom of pomFiles) {
    try {
      const content = readFileSync(pom, 'utf8');
      if (!content.includes('spring-boot')) continue;
    } catch { continue; }

    const serviceDir = pom.replace(/\/pom\.xml$/, '');
    if (processedDirs.has(serviceDir)) continue;
    processedDirs.add(serviceDir);

    const result = indexJavaSpringService(workspaceRoot, serviceDir);
    allEndpoints.push(...result.endpoints);
    allFeignClients.push(...result.feignClients);
    if (!serviceNames.includes(result.serviceName)) serviceNames.push(result.serviceName);
  }

  // If no pom.xml found, try indexing root as a single service
  if (pomFiles.length === 0) {
    const result = indexJavaSpringService(workspaceRoot, workspaceRoot);
    allEndpoints.push(...result.endpoints);
    allFeignClients.push(...result.feignClients);
    serviceNames.push(result.serviceName);
  }

  return {
    endpoints: allEndpoints,
    feignClients: allFeignClients,
    serviceName: serviceNames.join(', '),
  };
}
```

---

### α-5 · Create `MavenDependencyIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/mavenDependencyIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * MavenDependencyIndexer — parses all pom.xml files in a workspace and builds
 * a dependency graph for shared library impact analysis.
 * Uses xml2js (already in package.json as ^0.5.0).
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { parseStringPromise } from 'xml2js';
import { MavenDep } from './repoIntelligenceDb.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'out', '.gradle']);

/** Recursively find all pom.xml files in a workspace. */
function findPomFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 6) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) findPomFiles(full, results, depth + 1);
    else if (entry === 'pom.xml') results.push(full);
  }
  return results;
}

function getStr(node: unknown): string {
  if (Array.isArray(node)) return String(node[0] ?? '');
  return String(node ?? '');
}

export type MavenIndexResult = {
  deps: MavenDep[];
  pomCount: number;
};

export async function indexMavenDependencies(workspaceRoot: string): Promise<MavenIndexResult> {
  const pomFiles = findPomFiles(workspaceRoot);
  const deps: MavenDep[] = [];

  for (const pomPath of pomFiles) {
    let content: string;
    try { content = readFileSync(pomPath, 'utf8'); } catch { continue; }

    let parsed: any;
    try { parsed = await parseStringPromise(content, { explicitArray: true }); }
    catch { continue; }

    const project = parsed?.project;
    if (!project) continue;

    const relPath = relative(workspaceRoot, pomPath);
    const dependenciesNode = project.dependencies?.[0]?.dependency ?? [];

    for (const dep of dependenciesNode) {
      const groupId = getStr(dep.groupId);
      const artifactId = getStr(dep.artifactId);
      if (!groupId || !artifactId) continue;

      deps.push({
        consumerPath: relPath,
        groupId,
        artifactId,
        version: getStr(dep.version) || undefined,
        scope: getStr(dep.scope) || undefined,
      });
    }

    // Also check dependencyManagement section
    const dmDeps = project.dependencyManagement?.[0]?.dependencies?.[0]?.dependency ?? [];
    for (const dep of dmDeps) {
      const groupId = getStr(dep.groupId);
      const artifactId = getStr(dep.artifactId);
      if (!groupId || !artifactId) continue;
      deps.push({
        consumerPath: relPath,
        groupId,
        artifactId,
        version: getStr(dep.version) || undefined,
        scope: 'management',
      });
    }
  }

  return { deps, pomCount: pomFiles.length };
}
```

---

### α-6 · Create `KubernetesYamlIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/kubernetesYamlIndexer.ts`
*(New file — create it)*

Uses lightweight regex parsing to avoid adding `js-yaml` as a dep.

```typescript
/*---------------------------------------------------------------------------
 * KubernetesYamlIndexer — parses K8s manifest YAML files.
 * Regex-based (no js-yaml) for minimal dependency footprint.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { K8sResource } from './repoIntelligenceDb.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build']);
const K8S_KINDS = new Set([
  'Deployment', 'Service', 'Ingress', 'ConfigMap', 'Secret',
  'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'HorizontalPodAutoscaler',
]);

function collectYamlFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 6) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collectYamlFiles(full, results, depth + 1);
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) results.push(full);
  }
  return results;
}

/** Infer environment label from the file path (dev/qa/stage/prod). */
function inferEnvLabel(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const env of ['prod', 'stage', 'qa', 'dev']) {
    if (lower.includes(env)) return env;
  }
  return undefined;
}

/** Extract top-level YAML scalar value for a key. */
function extractYamlScalar(content: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  return content.match(regex)?.[1]?.trim();
}

/** Extract metadata.name from a K8s manifest block. */
function extractMetadataName(block: string): string | undefined {
  const nameMatch = block.match(/^metadata:\s*\n(?:(?:  [^\n]*)\n)*\s+name:\s*(.+)/m);
  return nameMatch?.[1]?.trim();
}

/** Extract namespace from metadata. */
function extractNamespace(block: string): string | undefined {
  const nsMatch = block.match(/namespace:\s*(.+)/);
  return nsMatch?.[1]?.trim();
}

/** Extract container image from a Deployment spec. */
function extractImage(block: string): string | undefined {
  const imageMatch = block.match(/^\s+image:\s*(.+)$/m);
  return imageMatch?.[1]?.trim();
}

export function indexKubernetesManifests(workspaceRoot: string, configDir?: string): K8sResource[] {
  const searchDir = configDir ?? workspaceRoot;
  const yamlFiles = collectYamlFiles(searchDir);
  const resources: K8sResource[] = [];

  for (const filePath of yamlFiles) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

    const relPath = relative(workspaceRoot, filePath);
    const envLabel = inferEnvLabel(filePath);

    // Split multi-document YAML (--- separator)
    const documents = content.split(/^---\s*$/m).filter(d => d.trim().length > 0);

    for (const doc of documents) {
      const kind = extractYamlScalar(doc, 'kind');
      if (!kind || !K8S_KINDS.has(kind)) continue;

      const name = extractMetadataName(doc);
      if (!name) continue;

      const namespace = extractNamespace(doc);
      const imageTag = kind === 'Deployment' ? extractImage(doc) : undefined;

      resources.push({ filePath: relPath, kind, name, namespace, envLabel, imageTag });
    }
  }

  return resources;
}
```

---

### α-7 · Create `GatewayRouteIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/gatewayRouteIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * GatewayRouteIndexer — parses Spring Cloud Gateway routes from
 * application.yml files. Looks for the standard spring.cloud.gateway.routes
 * configuration block.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GatewayRoute } from './repoIntelligenceDb.js';

function findGatewayConfigFiles(workspaceRoot: string): string[] {
  const SKIP = new Set(['node_modules', '.git', 'target', 'build']);
  const results: string[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 8) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if ((entry === 'application.yml' || entry === 'application.yaml')) {
        results.push(full);
      }
    }
  }

  walk(workspaceRoot);
  return results;
}

export function indexGatewayRoutes(workspaceRoot: string): GatewayRoute[] {
  const configFiles = findGatewayConfigFiles(workspaceRoot);
  const routes: GatewayRoute[] = [];

  for (const filePath of configFiles) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

    // Only process files that look like gateway config
    if (!content.includes('spring.cloud.gateway') && !content.includes('cloud:\n    gateway:')) continue;

    // Extract route blocks using indentation-aware regex
    // Matches: - id: <routeId>\n   uri: <uri>\n   predicates:\n     - Path=<path>
    const routeBlockRegex = /- id:\s*([^\n]+)\s*\n\s+uri:\s*([^\n]+)\s*(?:\n\s+.*?)*?predicates:\s*\n(\s+- [^\n]+\n)*/g;
    let match: RegExpExecArray | null;

    while ((match = routeBlockRegex.exec(content)) !== null) {
      const routeId = match[1].trim();
      const uri = match[2].trim();
      const restBlock = match[0];

      // Extract Path= predicate
      const pathMatch = restBlock.match(/Path=([^,\n\]]+)/);
      if (!pathMatch) continue;
      const pathPredicate = pathMatch[1].trim();

      // Determine if StripPrefix filter is present
      const stripPrefix = /StripPrefix/.test(restBlock);

      // Extract target service name from lb://service-name
      const targetService = uri.replace(/^lb:\/\//, '');

      routes.push({ routeId, pathPredicate, targetService, stripPrefix });
    }

    // Fallback: simpler key=value style
    if (routes.length === 0) {
      const simpleRoutes = content.matchAll(/id:\s*([^\n]+)\s*\n.*?uri:\s*(lb:\/\/[^\n]+)\s*\n.*?Path=([^\n,\]]+)/gs);
      for (const m of simpleRoutes) {
        routes.push({
          routeId: m[1].trim(),
          pathPredicate: m[3].trim(),
          targetService: m[2].trim().replace(/^lb:\/\//, ''),
          stripPrefix: false,
        });
      }
    }
  }

  return routes;
}
```

---

### α-8 · Wire All New Indexers into `_scanWorkspace()`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

**Edit 8a — Add imports** at the top of the file (after existing imports):

```typescript
import { indexAllSpringServices } from './javaSpringIndexer.js';
import { indexMavenDependencies } from './mavenDependencyIndexer.js';
import { indexKubernetesManifests } from './kubernetesYamlIndexer.js';
import { indexGatewayRoutes } from './gatewayRouteIndexer.js';
import type { ServiceTopologySummary, MavenImpactSummary } from '../../common/repoIntelligenceTypes.js';
```

**Edit 8b — Extend `_scanWorkspace()`.** After the line `await this._db.replaceChunks(hash, chunks);`
and before the `sendLLMMessage` call for summaries, add:

```typescript
// ── STaaS polyglot indexing ──────────────────────────────────────────────
try {
  // Java/Spring Boot indexing
  const javaResult = indexAllSpringServices(workspaceRoot);
  if (javaResult.endpoints.length > 0 || javaResult.feignClients.length > 0) {
    await this._db.replaceSpringEndpoints(hash, javaResult.endpoints);
    await this._db.replaceFeignClients(hash, javaResult.feignClients);
    this._metricsService.capture('STaaS Java Indexed', {
      endpoints: javaResult.endpoints.length,
      feignClients: javaResult.feignClients.length,
    });
  }

  // Maven dependency graph
  const mavenResult = await indexMavenDependencies(workspaceRoot);
  if (mavenResult.pomCount > 0) {
    await this._db.replaceMavenDependencies(hash, mavenResult.deps);
    this._metricsService.capture('STaaS Maven Indexed', {
      pomCount: mavenResult.pomCount, depCount: mavenResult.deps.length,
    });
  }

  // Kubernetes manifest indexing
  const k8sResources = indexKubernetesManifests(workspaceRoot);
  if (k8sResources.length > 0) {
    await this._db.replaceK8sResources(hash, k8sResources);
    this._metricsService.capture('STaaS K8s Indexed', { resourceCount: k8sResources.length });
  }

  // Gateway route indexing
  const gatewayRoutes = indexGatewayRoutes(workspaceRoot);
  if (gatewayRoutes.length > 0) {
    await this._db.replaceGatewayRoutes(hash, gatewayRoutes);
    this._metricsService.capture('STaaS Gateway Indexed', { routeCount: gatewayRoutes.length });
  }

  // Build in-memory summary for WorkspaceProfile injection
  const [endpoints, feignClients, routes] = await Promise.all([
    this._db.getSpringEndpoints(hash),
    this._db.getFeignClients(hash),
    this._db.getGatewayRoutes(hash),
  ]);

  if (endpoints.length > 0) {
    // Aggregate feign edges: caller → [unique targets]
    const feignMap = new Map<string, Set<string>>();
    for (const e of feignClients) {
      if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
      feignMap.get(e.callerService)!.add(e.targetService);
    }
    const feignEdges = Array.from(feignMap.entries()).map(([caller, targets]) => ({
      caller, targets: Array.from(targets),
    }));

    const serviceNamesSet = new Set<string>();
    for (const ep of endpoints) serviceNamesSet.add(ep.serviceName);

    const topology: ServiceTopologySummary = {
      serviceCount: serviceNamesSet.size,
      serviceNames: Array.from(serviceNamesSet),
      gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
      feignEdges,
      totalEndpoints: endpoints.length,
    };
    profile.serviceTopologySummary = topology;
  }

  // Maven impact summary
  const mavenDeps = mavenResult.deps;
  if (mavenDeps.length > 0) {
    const artifactCountMap = new Map<string, Set<string>>();
    for (const d of mavenDeps) {
      if (!artifactCountMap.has(d.artifactId)) artifactCountMap.set(d.artifactId, new Set());
      artifactCountMap.get(d.artifactId)!.add(d.consumerPath);
    }
    // Only report shared libs (used by 2+ consumers)
    const sharedLibs = Array.from(artifactCountMap.entries())
      .filter(([, consumers]) => consumers.size >= 2)
      .map(([artifactId, consumers]) => ({ artifactId, consumerCount: consumers.size }))
      .sort((a, b) => b.consumerCount - a.consumerCount)
      .slice(0, 20);

    if (sharedLibs.length > 0) {
      const mavenImpact: MavenImpactSummary = { sharedLibs, pomCount: mavenResult.pomCount };
      profile.mavenImpactSummary = mavenImpact;
    }
  }
} catch (err) {
  console.error('[RepoIntelligence] STaaS polyglot indexing failed:', err);
  // Non-fatal: continue without STaaS context
}
```

**Edit 8c — Add `_db.upsertProfile` call after the topology block** to persist the enriched profile:

After the try/catch block above, update the profile in DB:
```typescript
// Persist enriched profile fields
await this._db.upsertProfile(hash, profile, scan.fileMeta);
```

(Note: if `upsertProfile` is already called earlier in `_scanWorkspace`, use `updateSummaries` or add
a new `updateExtendedProfile` method to `RepoIntelligenceDb` that updates the new JSON columns.)

---

### α-9 · Add New Service Methods to `IRepoIntelligenceMainService` Implementation

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

Append these three methods to the `RepoIntelligenceMainService` class:

```typescript
async getServiceTopology(workspaceRoot: string): Promise<ServiceTopologySummary | null> {
  const hash = hashWorkspaceRoot(workspaceRoot);
  await this._db.init();
  const [endpoints, feignClients, routes] = await Promise.all([
    this._db.getSpringEndpoints(hash),
    this._db.getFeignClients(hash),
    this._db.getGatewayRoutes(hash),
  ]);
  if (endpoints.length === 0) return null;

  const serviceNamesSet = new Set(endpoints.map(e => e.serviceName));
  const feignMap = new Map<string, Set<string>>();
  for (const e of feignClients) {
    if (!feignMap.has(e.callerService)) feignMap.set(e.callerService, new Set());
    feignMap.get(e.callerService)!.add(e.targetService);
  }

  return {
    serviceCount: serviceNamesSet.size,
    serviceNames: Array.from(serviceNamesSet),
    gatewayRoutes: routes.map(r => ({ pathPattern: r.pathPredicate, targetService: r.targetService })),
    feignEdges: Array.from(feignMap.entries()).map(([caller, targets]) => ({ caller, targets: Array.from(targets) })),
    totalEndpoints: endpoints.length,
  };
}

async getMavenImpact(workspaceRoot: string, artifactId: string): Promise<string[]> {
  const hash = hashWorkspaceRoot(workspaceRoot);
  await this._db.init();
  const consumers = await this._db.getMavenConsumers(hash, artifactId);
  return [...new Set(consumers.map(c => c.consumerPath))];
}

async resolveApiContract(
  workspaceRoot: string,
  httpMethod: string,
  pathPattern: string,
): Promise<import('../../common/repoIntelligenceTypes.js').ApiContractResult | null> {
  const hash = hashWorkspaceRoot(workspaceRoot);
  await this._db.init();
  const endpoints = await this._db.getSpringEndpoints(hash);

  // Exact match first
  let ep = endpoints.find(
    e => e.httpMethod === httpMethod.toUpperCase() && e.pathPattern === pathPattern,
  );
  // Wildcard prefix match (gateway-style /order/** → /order/{id})
  if (!ep) {
    ep = endpoints.find(e => {
      const prefix = pathPattern.replace(/\*\*$/, '').replace(/\/+$/, '');
      return e.httpMethod === httpMethod.toUpperCase() && e.pathPattern.startsWith(prefix);
    });
  }
  if (!ep) return null;

  // Resolve gateway route
  const routes = await this._db.getGatewayRoutes(hash);
  const route = routes.find(r => {
    const prefix = r.pathPredicate.replace(/\*\*$/, '').replace(/\/+$/, '');
    return ep!.pathPattern.startsWith(prefix) || ep!.pathPattern.startsWith(r.pathPredicate);
  });

  return {
    pathPattern: ep.pathPattern,
    httpMethod: ep.httpMethod,
    backendService: ep.serviceName,
    controllerClass: ep.controllerClass,
    handlerMethod: ep.handlerMethod,
    requestDto: ep.requestDto,
    responseDto: ep.responseDto,
    filePath: ep.filePath,
  };
}
```

---

### α-10 · Extend `serializeWorkspaceProfileForPrompt()` for STaaS Context

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

Inside `serializeWorkspaceProfileForPrompt()`, after the existing `lines.push` for `architectureSummary`
(around line 578), append:

```typescript
// ── STaaS Service Topology Block ─────────────────────────────────────────
if ((mode === 'agent' || mode === 'gather') && profile.serviceTopologySummary) {
  const topo = profile.serviceTopologySummary;
  lines.push(`\nMicroservice topology (${topo.serviceCount} services, ${topo.totalEndpoints} endpoints):`);

  if (topo.gatewayRoutes.length > 0) {
    lines.push(`Gateway routes:`);
    for (const r of topo.gatewayRoutes.slice(0, 15)) {
      lines.push(`  ${r.pathPattern} → ${r.targetService}`);
    }
    if (topo.gatewayRoutes.length > 15) {
      lines.push(`  …(${topo.gatewayRoutes.length - 15} more routes)`);
    }
  }

  if (topo.feignEdges.length > 0) {
    lines.push(`Feign call graph:`);
    for (const e of topo.feignEdges.slice(0, 10)) {
      lines.push(`  ${e.caller} → [${e.targets.join(', ')}]`);
    }
  }
}

// ── STaaS Maven Shared Library Summary ───────────────────────────────────
if ((mode === 'agent' || mode === 'gather') && profile.mavenImpactSummary) {
  const maven = profile.mavenImpactSummary;
  lines.push(`\nMaven shared libs (${maven.pomCount} pom.xml files):`);
  for (const lib of maven.sharedLibs.slice(0, 10)) {
    lines.push(`  ${lib.artifactId} — used by ${lib.consumerCount} services`);
  }
}
```

Also increase the `agent` char budget in `REPO_PROFILE_MAX_CHARS`:
```typescript
// In repoIntelligenceTypes.ts, change:
agent: 4_800,  // current
// To:
agent: 8_000,  // expanded for STaaS multi-service topology
```

---

### α-11 · Register 3 New Built-in Tools

#### Step A — Add to `BuiltinToolCallParams` and `BuiltinToolResultType`

**File:** `src/vs/workbench/contrib/trove/common/toolsServiceTypes.ts`

In `BuiltinToolCallParams`, add after the last entry:
```typescript
'query_service_topology': { query: string },
'resolve_api_contract': { httpMethod: string, pathPattern: string },
'get_maven_impact': { artifactId: string },
```

In `BuiltinToolResultType`, add:
```typescript
'query_service_topology': { summary: string },
'resolve_api_contract': { contract: string },
'get_maven_impact': { consumers: string[], impactLevel: 'critical' | 'high' | 'medium' | 'low' },
```

#### Step B — Register in `builtinTools`

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

After the `search_web` entry in the `builtinTools` object, add:

```typescript
query_service_topology: {
  name: 'query_service_topology',
  description: `Query the service mesh topology of a Spring Boot microservices workspace.
Returns gateway routes, Feign call edges between services, and endpoint counts.
Use before modifying any backend service to understand upstream callers and downstream dependencies.`,
  params: {
    query: { description: 'Natural language query about services (e.g. "which services call order-management", "what does the payment service expose")' },
  },
},

resolve_api_contract: {
  name: 'resolve_api_contract',
  description: `Resolve the full API contract for a given HTTP method and path.
Traces: gateway route → backend service → @RestController handler → Java DTO types.
Use before generating frontend API calls or backend handler changes to ensure type correctness.`,
  params: {
    http_method: { description: 'HTTP method (GET, POST, PUT, DELETE, PATCH)' },
    path_pattern: { description: 'API path pattern (e.g. /order/**, /user/{id})' },
  },
},

get_maven_impact: {
  name: 'get_maven_impact',
  description: `Analyse the blast radius of changing a Maven shared library.
Returns all pom.xml consumer paths and an impact level (critical if 10+ consumers).
Use before modifying any artifact in dependencies-be/ to understand downstream build risk.`,
  params: {
    artifact_id: { description: 'Maven artifactId of the shared library (e.g. ms-data-model, ms-dto, jwks-multitenancy-service)' },
  },
},
```

#### Step C — Implement in `ToolsService`

**File:** `src/vs/workbench/contrib/trove/browser/toolsService.ts`

In `this.validateParams`, add:
```typescript
query_service_topology: (params: RawToolParamsObj) => {
  const query = validateStr('query', params.query);
  return { query };
},
resolve_api_contract: (params: RawToolParamsObj) => {
  const httpMethod = validateStr('httpMethod', params.http_method ?? params.httpMethod);
  const pathPattern = validateStr('pathPattern', params.path_pattern ?? params.pathPattern);
  return { httpMethod, pathPattern };
},
get_maven_impact: (params: RawToolParamsObj) => {
  const artifactId = validateStr('artifactId', params.artifact_id ?? params.artifactId);
  return { artifactId };
},
```

In `this.callTool`, add:
```typescript
query_service_topology: async ({ query }) => {
  const profile = this.repoIntelligenceService.getProfileSync();
  const topo = profile?.serviceTopologySummary;
  if (!topo) {
    return { result: { summary: 'No Spring Boot services detected in this workspace. Ensure pom.xml files with spring-boot dependency exist.' } };
  }
  const queryLower = query.toLowerCase();
  // Simple keyword routing
  let summary = `Service Topology — ${topo.serviceCount} services, ${topo.totalEndpoints} endpoints\n\n`;

  if (queryLower.includes('gateway') || queryLower.includes('route')) {
    summary += `Gateway Routes:\n${topo.gatewayRoutes.map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
  } else if (queryLower.includes('feign') || queryLower.includes('call') || queryLower.includes('depend')) {
    summary += `Feign Dependencies:\n${topo.feignEdges.map(e => `  ${e.caller} calls: ${e.targets.join(', ')}`).join('\n')}`;
  } else {
    summary += `Services: ${topo.serviceNames.join(', ')}\n\n`;
    summary += `Gateway Routes:\n${topo.gatewayRoutes.slice(0, 10).map(r => `  ${r.pathPattern} → ${r.targetService}`).join('\n')}`;
  }
  return { result: { summary } };
},

resolve_api_contract: async ({ httpMethod, pathPattern }) => {
  const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
  if (!workspaceRoot) return { result: { contract: 'No workspace open.' } };

  const contract = await this.repoIntelligenceService.resolveApiContract(workspaceRoot, httpMethod, pathPattern);
  if (!contract) {
    return { result: { contract: `No endpoint found for ${httpMethod} ${pathPattern}. Check that the workspace has been indexed.` } };
  }

  const lines = [
    `API Contract: ${contract.httpMethod} ${contract.pathPattern}`,
    `Backend service: ${contract.backendService}`,
    `Controller: ${contract.controllerClass}.${contract.handlerMethod}()`,
    `File: ${contract.filePath}`,
  ];
  if (contract.requestDto) lines.push(`@RequestBody: ${contract.requestDto}`);
  if (contract.responseDto) lines.push(`Response type: ${contract.responseDto}`);

  return { result: { contract: lines.join('\n') } };
},

get_maven_impact: async ({ artifactId }) => {
  const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
  if (!workspaceRoot) return { result: { consumers: [], impactLevel: 'low' } };

  const consumers = await this.repoIntelligenceService.getMavenImpact(workspaceRoot, artifactId);
  const count = consumers.length;
  const impactLevel = count >= 10 ? 'critical' : count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';

  return { result: { consumers, impactLevel } };
},
```

In `this.stringOfResult`, add:
```typescript
query_service_topology: (_params, result) => result.summary,
resolve_api_contract: (_params, result) => result.contract,
get_maven_impact: (_params, result) => {
  const { consumers, impactLevel } = result;
  if (consumers.length === 0) return 'No consumers found for this artifact.';
  return `Impact level: ${impactLevel.toUpperCase()} — ${consumers.length} consumer(s):\n${consumers.join('\n')}`;
},
```

---

### α-12 · Add Java Symbol Patterns to `codeChunker.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/codeChunker.ts`

In the `SYMBOL_PATTERNS` object, add a `Java` entry after the `Rust` entry:

```typescript
Java: [
  { nameRegex: /^(?:public\s+)?(?:static\s+)?\w+\s+(\w+)\s*\(/m, kind: 'function', exportRegex: /^public\s/ },
  { nameRegex: /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class', exportRegex: /^public\s/ },
  { nameRegex: /^(?:public\s+)?interface\s+(\w+)/m, kind: 'interface', exportRegex: /^public\s/ },
  { nameRegex: /^(?:public\s+)?enum\s+(\w+)/m, kind: 'enum', exportRegex: /^public\s/ },
],
```

In `LANGUAGE_BOUNDARIES`, add:

```typescript
Java: [
  { regex: /^(?:public\s+)?(?:abstract\s+)?class\s+\w/m, chunkType: 'class' },
  { regex: /^(?:public\s+)?interface\s+\w/m, chunkType: 'block' },
  { regex: /^\s+(?:public|private|protected)\s+\w+\s+\w+\s*\(/m, chunkType: 'function' },
],
```

Also remove `'XML'` from `SKIP_LANGUAGES` (pom.xml parsing is handled separately by `MavenDependencyIndexer`).

---

### α-13 · Phase α Tests

Create the following test files following the existing `*.test.ts` pattern in
`src/vs/workbench/contrib/trove/browser/test/`:

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/javaSpringIndexer.test.ts`

```typescript
import * as assert from 'assert';
import { indexJavaSpringService } from '../javaSpringIndexer.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

suite('JavaSpringIndexer', () => {
  let tempDir: string;

  setup(() => {
    tempDir = join(tmpdir(), `trove-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch {} });

  test('detects @RestController endpoints', () => {
    const src = join(tempDir, 'src', 'main', 'java', 'com', 'example');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'OrderController.java'), `
@RestController
@RequestMapping("/order")
public class OrderController {
  @GetMapping("/{id}")
  public OrderResponse getOrder(@PathVariable Long id) { return null; }

  @PostMapping
  public OrderResponse createOrder(@RequestBody OrderRequest req) { return null; }
}
`);
    const result = indexJavaSpringService(tempDir, tempDir);
    assert.ok(result.endpoints.length >= 2, 'Should detect at least 2 endpoints');
    const getEp = result.endpoints.find(e => e.httpMethod === 'GET');
    assert.ok(getEp, 'Should have a GET endpoint');
    assert.ok(getEp.pathPattern.includes('/order'), 'Path should include /order');
  });

  test('detects @FeignClient declarations', () => {
    const src = join(tempDir, 'src', 'main', 'java');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'OrderServiceClient.java'), `
@FeignClient(name = "staas-order-management")
public interface OrderServiceClient {
  @GetMapping("/order/{id}")
  OrderResponse getOrder(@PathVariable Long id);
}
`);
    const result = indexJavaSpringService(tempDir, tempDir);
    assert.ok(result.feignClients.length >= 1, 'Should detect FeignClient');
    assert.strictEqual(result.feignClients[0].targetService, 'staas-order-management');
  });
});
```

---

## Phase β — Shared Library Impact + Env Config Diff + Multi-Tenant Context

**Goal:** Extend the agent with cross-library blast-radius analysis, multi-environment config
awareness, and tenant-aware code generation guardrails.

---

### β-1 · Create `NpmImpactIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/npmImpactIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * NpmImpactIndexer — builds an NPM package dependency graph across all
 * package.json files in the workspace. Tracks @mobilitystore/* and @bosch/*
 * scoped packages for STaaS shared library impact analysis.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

export type NpmPackageEdge = {
  consumerPath: string;    // relative path to the consuming package.json
  packageName: string;     // e.g. @mobilitystore/components-interface
  version: string;
  depType: 'dependencies' | 'devDependencies' | 'peerDependencies';
};

export type NpmImpactResult = {
  edges: NpmPackageEdge[];
  packageJsonCount: number;
};

function findPackageJsonFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 5) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) findPackageJsonFiles(full, results, depth + 1);
    else if (entry === 'package.json') results.push(full);
  }
  return results;
}

export function indexNpmDependencies(workspaceRoot: string, scopeFilter?: string[]): NpmImpactResult {
  const packageJsonFiles = findPackageJsonFiles(workspaceRoot);
  const edges: NpmPackageEdge[] = [];
  const defaultScopes = scopeFilter ?? ['@mobilitystore', '@bosch'];

  for (const pkgPath of packageJsonFiles) {
    let pkg: any;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { continue; }
    const relPath = relative(workspaceRoot, pkgPath);

    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const deps = pkg[depType] ?? {};
      for (const [packageName, version] of Object.entries<string>(deps)) {
        const isScoped = defaultScopes.some(s => packageName.startsWith(s));
        if (!isScoped) continue;
        edges.push({ consumerPath: relPath, packageName, version, depType });
      }
    }
  }

  return { edges, packageJsonCount: packageJsonFiles.length };
}
```

---


### β-2 · Create `ConfigEnvIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/configEnvIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * ConfigEnvIndexer — parses application-{env}.yml files across all Spring
 * Boot services and identifies property drift between environments.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build']);
const ENV_PATTERN = /application-(\w+)\.(yml|yaml)$/;

export type ConfigProperty = {
  filePath: string;
  serviceName: string;
  env: string;
  key: string;
  value: string;
};

export type EnvDrift = {
  key: string;
  serviceName: string;
  envValues: Record<string, string>;   // { dev: '3000', prod: '5000' }
};

function collectConfigFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 8) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collectConfigFiles(full, results, depth + 1);
    else if (ENV_PATTERN.test(entry)) results.push(full);
  }
  return results;
}

function deriveServiceName(filePath: string): string {
  const parts = filePath.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith('staas-') || parts[i].includes('-service') || parts[i].includes('-management')) {
      return parts[i];
    }
  }
  return parts[parts.length - 3] ?? 'unknown';
}

/** Flat-parse YAML into dot-notation key=value pairs. */
function flatParseYaml(content: string): Record<string, string> {
  const results: Record<string, string> = {};
  const lines = content.split('\n');
  const stack: { indent: number; key: string }[] = [];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const keyValueMatch = line.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!keyValueMatch) continue;

    const key = keyValueMatch[2].trim();
    const value = keyValueMatch[3].trim();

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const fullKey = [...stack.map(s => s.key), key].join('.');

    if (value && !value.startsWith('{') && !value.startsWith('[')) {
      results[fullKey] = value;
    } else {
      stack.push({ indent, key });
    }
  }
  return results;
}

export type ConfigIndexResult = {
  properties: ConfigProperty[];
  envDrift: EnvDrift[];
  fileCount: number;
};

export function indexConfigEnvironments(workspaceRoot: string): ConfigIndexResult {
  const configFiles = collectConfigFiles(workspaceRoot);
  const allProperties: ConfigProperty[] = [];

  for (const filePath of configFiles) {
    const match = filePath.match(ENV_PATTERN);
    if (!match) continue;
    const env = match[1];
    const serviceName = deriveServiceName(filePath);

    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }

    const parsed = flatParseYaml(content);
    const relPath = relative(workspaceRoot, filePath);

    for (const [key, value] of Object.entries(parsed)) {
      allProperties.push({ filePath: relPath, serviceName, env, key, value });
    }
  }

  // Detect drift: same key+service, different values across envs
  const grouped = new Map<string, Map<string, string>>();
  for (const prop of allProperties) {
    const compositeKey = `${prop.serviceName}::${prop.key}`;
    if (!grouped.has(compositeKey)) grouped.set(compositeKey, new Map());
    grouped.get(compositeKey)!.set(prop.env, prop.value);
  }

  const envDrift: EnvDrift[] = [];
  for (const [compositeKey, envValues] of grouped.entries()) {
    if (envValues.size < 2) continue;
    const values = Array.from(envValues.values());
    const hasDrift = values.some(v => v !== values[0]);
    if (!hasDrift) continue;
    const [serviceName, ...keyParts] = compositeKey.split('::');
    envDrift.push({
      key: keyParts.join('::'),
      serviceName,
      envValues: Object.fromEntries(envValues),
    });
  }

  return { properties: allProperties, envDrift, fileCount: configFiles.length };
}
```

---

### β-3 · Extend DB Schema for Phase β Tables

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceDb.ts`

**Edit 3a — Bump `SCHEMA_VERSION` from 3 to 4.**

**Edit 3b — Append to `SCHEMA` constant** (after the `gateway_routes` table block added in α-1):

```sql
-- ── Phase β: NPM impact + config drift ─────────────────────────────────

CREATE TABLE IF NOT EXISTS npm_package_edges (
  workspace_hash  TEXT NOT NULL,
  consumer_path   TEXT NOT NULL,
  package_name    TEXT NOT NULL,
  version         TEXT,
  dep_type        TEXT,
  PRIMARY KEY (workspace_hash, consumer_path, package_name),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_npm_package ON npm_package_edges(workspace_hash, package_name);
CREATE INDEX IF NOT EXISTS idx_npm_consumer ON npm_package_edges(workspace_hash, consumer_path);

CREATE TABLE IF NOT EXISTS config_env_drift (
  workspace_hash    TEXT NOT NULL,
  service_name      TEXT NOT NULL,
  config_key        TEXT NOT NULL,
  env_values_json   TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, service_name, config_key),
  FOREIGN KEY (workspace_hash) REFERENCES workspace_profiles(workspace_hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_drift_service ON config_env_drift(workspace_hash, service_name);
```

**Edit 3c — Add migration guard in `_migrate()`** (inside the STaaS block added in α-1c):

```typescript
await this._ensureTable(db, 'npm_package_edges',
  `CREATE TABLE IF NOT EXISTS npm_package_edges (
    workspace_hash TEXT NOT NULL, consumer_path TEXT NOT NULL,
    package_name TEXT NOT NULL, version TEXT, dep_type TEXT,
    PRIMARY KEY (workspace_hash, consumer_path, package_name)
  )`);
await this._ensureTable(db, 'config_env_drift',
  `CREATE TABLE IF NOT EXISTS config_env_drift (
    workspace_hash TEXT NOT NULL, service_name TEXT NOT NULL,
    config_key TEXT NOT NULL, env_values_json TEXT NOT NULL,
    PRIMARY KEY (workspace_hash, service_name, config_key)
  )`);
```

**Edit 3d — Add new type exports** (before the `RepoIntelligenceDb` class):

```typescript
export type NpmPackageEdge = {
  consumerPath: string;
  packageName: string;
  version: string;
  depType: 'dependencies' | 'devDependencies' | 'peerDependencies';
};

// EnvDrift re-exported for use in DB methods
export type { EnvDrift } from './configEnvIndexer.js';
```

**Edit 3e — Add four new public DB methods** (append before the closing `}` of `RepoIntelligenceDb`):

```typescript
// ── β methods ─────────────────────────────────────────────────────────────

async replaceNpmEdges(workspaceHash: string, edges: NpmPackageEdge[]): Promise<void> {
  await this._run(`DELETE FROM npm_package_edges WHERE workspace_hash = ?`, [workspaceHash]);
  for (const e of edges) {
    await this._run(
      `INSERT OR REPLACE INTO npm_package_edges
         (workspace_hash, consumer_path, package_name, version, dep_type)
       VALUES (?, ?, ?, ?, ?)`,
      [workspaceHash, e.consumerPath, e.packageName, e.version, e.depType],
    );
  }
}

async getNpmConsumers(workspaceHash: string, packageName: string): Promise<string[]> {
  type Row = { consumer_path: string };
  const rows = await this._all<Row>(
    `SELECT DISTINCT consumer_path FROM npm_package_edges
     WHERE workspace_hash = ? AND package_name = ?`,
    [workspaceHash, packageName],
  );
  return rows.map(r => r.consumer_path);
}

async replaceConfigDrift(workspaceHash: string, drifts: import('./configEnvIndexer.js').EnvDrift[]): Promise<void> {
  await this._run(`DELETE FROM config_env_drift WHERE workspace_hash = ?`, [workspaceHash]);
  for (const d of drifts) {
    await this._run(
      `INSERT OR REPLACE INTO config_env_drift
         (workspace_hash, service_name, config_key, env_values_json)
       VALUES (?, ?, ?, ?)`,
      [workspaceHash, d.serviceName, d.key, JSON.stringify(d.envValues)],
    );
  }
}

async getConfigDriftForService(
  workspaceHash: string,
  serviceName: string,
): Promise<{ key: string; serviceName: string; envValues: Record<string, string> }[]> {
  type Row = { service_name: string; config_key: string; env_values_json: string };
  const rows = await this._all<Row>(
    `SELECT service_name, config_key, env_values_json
     FROM config_env_drift WHERE workspace_hash = ? AND service_name = ?
     ORDER BY config_key`,
    [workspaceHash, serviceName],
  );
  return rows.map(r => ({
    key: r.config_key,
    serviceName: r.service_name,
    envValues: JSON.parse(r.env_values_json) as Record<string, string>,
  }));
}
```

---

### β-4 · Wire Phase β Indexers into `_scanWorkspace()`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

**Edit 4a — Add imports** at the top:

```typescript
import { indexNpmDependencies } from './npmImpactIndexer.js';
import { indexConfigEnvironments } from './configEnvIndexer.js';
```

**Edit 4b — Append inside the existing STaaS try/catch block** (added in α-8b), after the
`profile.mavenImpactSummary = mavenImpact;` assignment:

```typescript
// ── Phase β: NPM shared library impact ──────────────────────────────────
const npmResult = indexNpmDependencies(workspaceRoot);
if (npmResult.edges.length > 0) {
  await this._db.replaceNpmEdges(hash, npmResult.edges);

  // Build NPM impact summary for WorkspaceProfile
  const npmImpactMap = new Map<string, Set<string>>();
  for (const e of npmResult.edges) {
    if (!npmImpactMap.has(e.packageName)) npmImpactMap.set(e.packageName, new Set());
    npmImpactMap.get(e.packageName)!.add(e.consumerPath);
  }
  const topNpmLibs = Array.from(npmImpactMap.entries())
    .filter(([, consumers]) => consumers.size >= 2)
    .map(([packageName, consumers]) => ({ packageName, consumerCount: consumers.size }))
    .sort((a, b) => b.consumerCount - a.consumerCount)
    .slice(0, 15);

  if (topNpmLibs.length > 0) {
    profile.npmImpactSummary = {
      sharedPackages: topNpmLibs,
      packageJsonCount: npmResult.packageJsonCount,
    };
  }

  this._metricsService.capture('STaaS NPM Indexed', {
    packageJsonCount: npmResult.packageJsonCount,
    edgeCount: npmResult.edges.length,
  });
}

// ── Phase β: Config environment drift ────────────────────────────────────
const configResult = indexConfigEnvironments(workspaceRoot);
if (configResult.fileCount > 0) {
  await this._db.replaceConfigDrift(hash, configResult.envDrift);

  if (configResult.envDrift.length > 0) {
    profile.configDriftSummary = {
      driftCount: configResult.envDrift.length,
      fileCount: configResult.fileCount,
      // Surface top 5 most-drifted services for prompt injection
      topDriftedServices: [...new Set(configResult.envDrift.map(d => d.serviceName))].slice(0, 5),
    };
  }

  this._metricsService.capture('STaaS Config Indexed', {
    fileCount: configResult.fileCount,
    driftCount: configResult.envDrift.length,
  });
}
```

**Edit 4c — Add new method implementations** to `RepoIntelligenceMainService`:

```typescript
async getNpmConsumers(workspaceRoot: string, packageName: string): Promise<string[]> {
  const hash = hashWorkspaceRoot(workspaceRoot);
  await this._db.init();
  return this._db.getNpmConsumers(hash, packageName);
}

async getConfigDrift(
  workspaceRoot: string,
  serviceName: string,
): Promise<{ key: string; envValues: Record<string, string> }[]> {
  const hash = hashWorkspaceRoot(workspaceRoot);
  await this._db.init();
  return this._db.getConfigDriftForService(hash, serviceName);
}
```

---

### β-5 · Extend `WorkspaceProfile` with Phase β Fields

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts`

Append to the `WorkspaceProfile` type (after `mavenImpactSummary`):

```typescript
/** NPM shared package impact summary (@mobilitystore/*, @bosch/*) */
npmImpactSummary?: NpmImpactSummary | null;
/** Multi-environment config drift summary */
configDriftSummary?: ConfigDriftSummary | null;
```

Add the two new types:

```typescript
export type NpmImpactSummary = {
  sharedPackages: { packageName: string; consumerCount: number }[];
  packageJsonCount: number;
};

export type ConfigDriftSummary = {
  driftCount: number;
  fileCount: number;
  topDriftedServices: string[];
};
```

Add method signatures to `IRepoIntelligenceMainService`:

```typescript
getNpmConsumers(workspaceRoot: string, packageName: string): Promise<string[]>;
getConfigDrift(workspaceRoot: string, serviceName: string): Promise<{ key: string; envValues: Record<string, string> }[]>;
```

---

### β-6 · Extend `serializeWorkspaceProfileForPrompt()` with Phase β Blocks

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

After the Maven impact block added in α-10, append:

```typescript
// ── NPM Shared Library Summary ─────────────────────────────────────────
if ((mode === 'agent' || mode === 'gather') && profile.npmImpactSummary) {
  const npm = profile.npmImpactSummary;
  lines.push(`\nNPM shared libs (${npm.packageJsonCount} package.json files):`);
  for (const pkg of npm.sharedPackages.slice(0, 8)) {
    lines.push(`  ${pkg.packageName} — ${pkg.consumerCount} consumer(s)`);
  }
}

// ── Config Environment Drift Alert ────────────────────────────────────
if (mode === 'agent' && profile.configDriftSummary && profile.configDriftSummary.driftCount > 0) {
  const drift = profile.configDriftSummary;
  lines.push(
    `\nConfig drift detected: ${drift.driftCount} properties differ across environments` +
    ` (services with drift: ${drift.topDriftedServices.join(', ')}).` +
    ` Call get_config_drift before editing any application-{env}.yml file.`
  );
}
```

---

### β-7 · Register Phase β Tools (3-File Pattern)

**Tool 1: `get_npm_impact`**

**`toolsServiceTypes.ts`** — add to `BuiltinToolCallParams`:
```typescript
'get_npm_impact': { packageName: string },
```
Add to `BuiltinToolResultType`:
```typescript
'get_npm_impact': { consumers: string[]; impactLevel: 'critical' | 'high' | 'medium' | 'low' },
```

**`prompts.ts`** — add to `builtinTools`:
```typescript
get_npm_impact: {
  name: 'get_npm_impact',
  description: `Returns all frontend apps and packages that consume a given @mobilitystore/* or @bosch/*
npm package. Returns an impact level: critical (5+ consumers), high (3-4), medium (1-2), low (none).
Use before modifying any shared frontend library in the dependencies-fe/ or api-endpoints.ts scope.`,
  params: {
    package_name: { description: 'Full scoped package name, e.g. @mobilitystore/components-interface or @bosch/frontend.kit-npm' },
  },
},
```

**`toolsService.ts`** — add to `validateParams`:
```typescript
get_npm_impact: (params: RawToolParamsObj) => ({
  packageName: validateStr('packageName', params.package_name ?? params.packageName),
}),
```
Add to `callTool`:
```typescript
get_npm_impact: async ({ packageName }) => {
  const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
  if (!workspaceRoot) return { result: { consumers: [], impactLevel: 'low' as const } };

  const consumers = await this.repoIntelligenceService.getNpmConsumers(workspaceRoot, packageName);
  const count = consumers.length;
  const impactLevel =
    count >= 5 ? 'critical' :
    count >= 3 ? 'high' :
    count >= 1 ? 'medium' : 'low';
  return { result: { consumers, impactLevel } };
},
```
Add to `stringOfResult`:
```typescript
get_npm_impact: (_p, result) => {
  if (result.consumers.length === 0) return `No consumers found for this package.`;
  return `Impact: ${result.impactLevel.toUpperCase()} — ${result.consumers.length} consumer(s):\n${result.consumers.join('\n')}`;
},
```

---

**Tool 2: `get_config_drift`**

**`toolsServiceTypes.ts`** — add:
```typescript
'get_config_drift': { serviceName: string },
// Result:
'get_config_drift': { drifts: { key: string; envValues: Record<string, string> }[]; summary: string },
```

**`prompts.ts`** — add to `builtinTools`:
```typescript
get_config_drift: {
  name: 'get_config_drift',
  description: `Returns all Spring Cloud Config properties that differ across environments
(dev/qa/stage/prod) for a named service. Use before editing any application-{env}.yml
file to understand environment-specific constraints and avoid accidental config divergence.`,
  params: {
    service_name: { description: 'Spring Boot service name, e.g. staas-order-management or staas-pricing-management' },
  },
},
```

**`toolsService.ts`** — implement:
```typescript
get_config_drift: async ({ serviceName }) => {
  const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
  if (!workspaceRoot) return { result: { drifts: [], summary: 'No workspace open.' } };

  const drifts = await this.repoIntelligenceService.getConfigDrift(workspaceRoot, serviceName);
  if (drifts.length === 0) {
    return { result: { drifts: [], summary: `No config drift detected for ${serviceName} across environments.` } };
  }

  const lines = [`Config drift for ${serviceName} (${drifts.length} properties):\n`];
  for (const d of drifts.slice(0, 20)) {
    const envPairs = Object.entries(d.envValues).map(([e, v]) => `${e}=${v}`).join(', ');
    lines.push(`  ${d.key}: ${envPairs}`);
  }
  if (drifts.length > 20) lines.push(`  …(${drifts.length - 20} more properties)`);

  return { result: { drifts, summary: lines.join('\n') } };
},
```
```typescript
// stringOfResult:
get_config_drift: (_p, result) => result.summary,
```

---

## Phase γ — Infrastructure, ONDC & Security

**Goal:** Give the agent awareness of Terraform/K8s provisioned resources, GitLab CI blast radius,
ONDC protocol requirements, and a pre-commit security rule engine for the platform's multi-tenancy
and JWT constraints.

---

### γ-1 · Create `TerraformIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/terraformIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * TerraformIndexer — regex-based parser for .tf (Terraform HCL) files.
 * Extracts resource blocks, module declarations, and variable bindings.
 * No external HCL parser — follows the regex-based convention of codeChunker.ts.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', 'target', 'build', '.terraform.lock.hcl']);

export type TerraformResource = {
  filePath: string;
  resourceType: string;   // e.g. azurerm_kubernetes_cluster
  resourceName: string;   // e.g. aks_prod
  provider: string;       // e.g. azurerm
};

export type TerraformModule = {
  filePath: string;
  moduleName: string;
  source: string;
};

export type TerraformIndexResult = {
  resources: TerraformResource[];
  modules: TerraformModule[];
  providers: string[];
  fileCount: number;
};

function collectTfFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 6) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.endsWith('.tfstate') || entry.endsWith('.tfvars')) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collectTfFiles(full, results, depth + 1);
    else if (entry.endsWith('.tf')) results.push(full);
  }
  return results;
}

export function indexTerraformResources(workspaceRoot: string): TerraformIndexResult {
  const tfFiles = collectTfFiles(workspaceRoot);
  const resources: TerraformResource[] = [];
  const modules: TerraformModule[] = [];
  const providerSet = new Set<string>();

  for (const filePath of tfFiles) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    const relPath = relative(workspaceRoot, filePath);

    // resource "azurerm_kubernetes_cluster" "aks_prod" { ... }
    const resourceRegex = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm;
    let match: RegExpExecArray | null;
    while ((match = resourceRegex.exec(content)) !== null) {
      const resourceType = match[1];
      const resourceName = match[2];
      const provider = resourceType.split('_')[0];
      providerSet.add(provider);
      resources.push({ filePath: relPath, resourceType, resourceName, provider });
    }

    // module "network" { source = "./modules/vnet" }
    const moduleRegex = /^module\s+"([^"]+)"\s*\{[^}]*source\s*=\s*"([^"]+)"/gms;
    let modMatch: RegExpExecArray | null;
    while ((modMatch = moduleRegex.exec(content)) !== null) {
      modules.push({ filePath: relPath, moduleName: modMatch[1], source: modMatch[2] });
    }

    // provider "azurerm" { ... }
    const providerRegex = /^provider\s+"([^"]+)"/gm;
    let provMatch: RegExpExecArray | null;
    while ((provMatch = providerRegex.exec(content)) !== null) {
      providerSet.add(provMatch[1]);
    }
  }

  return {
    resources,
    modules,
    providers: Array.from(providerSet),
    fileCount: tfFiles.length,
  };
}
```

---

### γ-2 · Create `GitlabCiIndexer.ts`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/gitlabCiIndexer.ts`
*(New file — create it)*

```typescript
/*---------------------------------------------------------------------------
 * GitlabCiIndexer — parses .gitlab-ci.yml and auto-merge-template files
 * to build a pipeline stage DAG for blast-radius estimation.
 *---------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'build', 'dist']);

export type PipelineJob = {
  name: string;
  stage: string;
  needs: string[];      // direct job dependencies
  filePath: string;
};

export type PipelineStage = {
  name: string;         // e.g. build, test, deploy-dev, deploy-prod
  jobs: string[];
};

export type PipelineIndexResult = {
  jobs: PipelineJob[];
  stages: PipelineStage[];
  hasManualGates: boolean;   // any job with when: manual
  fileCount: number;
};

function collectCiFiles(dir: string, results: string[] = [], depth = 0): string[] {
  if (depth > 4) return results;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) collectCiFiles(full, results, depth + 1);
    else if (entry === '.gitlab-ci.yml' || entry.endsWith('-ci.yml') || entry.endsWith('-pipeline.yml')) {
      results.push(full);
    }
  }
  return results;
}

/** Simplified YAML block extractor for top-level job blocks. */
function extractJobBlocks(content: string): Map<string, string> {
  const jobs = new Map<string, string>();
  // Match top-level keys that are not reserved YAML pipeline keywords
  const RESERVED = new Set(['stages', 'variables', 'include', 'workflow', 'default', 'image', 'services', 'before_script', 'after_script', 'cache']);
  const topLevelKeys = [...content.matchAll(/^([a-zA-Z][\w:.-]+):\s*$/gm)];

  for (let i = 0; i < topLevelKeys.length; i++) {
    const keyMatch = topLevelKeys[i];
    const keyName = keyMatch[1];
    if (RESERVED.has(keyName)) continue;

    const startIdx = keyMatch.index! + keyMatch[0].length;
    const endIdx = i + 1 < topLevelKeys.length ? topLevelKeys[i + 1].index! : content.length;
    jobs.set(keyName, content.slice(startIdx, endIdx));
  }
  return jobs;
}

export function indexGitlabPipelines(workspaceRoot: string): PipelineIndexResult {
  const ciFiles = collectCiFiles(workspaceRoot);
  const allJobs: PipelineJob[] = [];
  const stageSet = new Map<string, Set<string>>();
  let hasManualGates = false;

  for (const filePath of ciFiles) {
    let content: string;
    try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
    const relPath = relative(workspaceRoot, filePath);

    // Extract stages list
    const stagesMatch = content.match(/^stages:\s*\n((?:\s+-\s+\w[\w-]*\n)+)/m);
    if (stagesMatch) {
      for (const stageMatch of stagesMatch[1].matchAll(/- ([\w-]+)/g)) {
        if (!stageSet.has(stageMatch[1])) stageSet.set(stageMatch[1], new Set());
      }
    }

    // Check for manual gates
    if (/when:\s*manual/.test(content)) hasManualGates = true;

    // Extract jobs
    const jobBlocks = extractJobBlocks(content);
    for (const [jobName, block] of jobBlocks.entries()) {
      const stageMatch = block.match(/^\s+stage:\s*(.+)$/m);
      const stage = stageMatch?.[1]?.trim() ?? 'test';

      const needsMatch = block.match(/^\s+needs:\s*\n((?:\s+-\s+\S+\n)+)/m);
      const needs: string[] = [];
      if (needsMatch) {
        for (const n of needsMatch[1].matchAll(/- ([\w:"-]+)/g)) {
          needs.push(n[1].replace(/^["']|["']$/g, ''));
        }
      }

      if (!stageSet.has(stage)) stageSet.set(stage, new Set());
      stageSet.get(stage)!.add(jobName);
      allJobs.push({ name: jobName, stage, needs, filePath: relPath });
    }
  }

  const stages: PipelineStage[] = Array.from(stageSet.entries()).map(([name, jobs]) => ({
    name,
    jobs: Array.from(jobs),
  }));

  return { jobs: allJobs, stages, hasManualGates, fileCount: ciFiles.length };
}
```

---

### γ-3 · Create `SecurityVerifierTool.ts`

**File:** `src/vs/workbench/contrib/trove/browser/securityVerifierTool.ts`
*(New file in browser/ — not electron-main, since it analyzes text passed directly by the agent)*

```typescript
/*---------------------------------------------------------------------------
 * SecurityVerifierTool — static analysis rules for STaaS multi-tenancy
 * isolation, JWT validation, OWASP compliance, and secret leak detection.
 * Called as a built-in tool; runs synchronously in the browser process.
 *---------------------------------------------------------------------------*/

export type SecurityViolation = {
  rule: string;
  severity: 'critical' | 'high' | 'medium';
  message: string;
};

export type SecurityVerifyResult = {
  violations: SecurityViolation[];
  passed: boolean;
  summary: string;
};

type SecurityRule = {
  id: string;
  severity: SecurityViolation['severity'];
  appliesTo: string[];       // file extensions this rule fires on
  check: (code: string) => boolean;
  message: string;
};

const SECURITY_RULES: SecurityRule[] = [
  {
    id: 'TENANT_ISOLATION_01',
    severity: 'critical',
    appliesTo: ['.java'],
    check: (code) => {
      const hasQuery = /@Query|findAll\s*\(\s*\)|\.findAll\s*\(|nativeQuery\s*=\s*true/.test(code);
      const hasTenantFilter = /tenantId|tenant_id|getTenantId|tenantContext|TenantContext/.test(code);
      return hasQuery && !hasTenantFilter;
    },
    message: 'TENANT_ISOLATION_01: DB query found without tenantId filter. All repository queries in multi-tenant STaaS services MUST filter by tenantId to prevent cross-tenant data exposure.',
  },
  {
    id: 'JWT_VALIDATION_01',
    severity: 'high',
    appliesTo: ['.java'],
    check: (code) => {
      const hasController = /@RestController|@Controller/.test(code);
      const hasMapping = /@GetMapping|@PostMapping|@PutMapping|@DeleteMapping|@PatchMapping|@RequestMapping/.test(code);
      const hasSecurity = /@PreAuthorize|@Secured|SecurityConfig|\.permitAll\(\)|\.authenticated\(\)|hasRole|hasAuthority/.test(code);
      return hasController && hasMapping && !hasSecurity;
    },
    message: 'JWT_VALIDATION_01: @RestController has endpoint mappings without @PreAuthorize or security configuration. All STaaS endpoints must declare explicit access control.',
  },
  {
    id: 'JWKS_RESOLUTION_01',
    severity: 'high',
    appliesTo: ['.yml', '.yaml'],
    check: (code) => /jwks-uri:\s*https?:\/\/(?!localhost|127\.0\.0\.1|\$\{)/.test(code),
    message: 'JWKS_RESOLUTION_01: Hardcoded JWKS URI in YAML config. Use the jwks-multitenancy-service for dynamic per-tenant JWKS resolution. Hardcoded URIs break multi-tenancy.',
  },
  {
    id: 'SECRET_LEAK_01',
    severity: 'critical',
    appliesTo: ['.yml', '.yaml'],
    check: (code) => {
      // Flag literal secrets: not ${...} placeholder, not empty, not a Spring expression
      return /(?:client-secret|password|secret-key|api-key):\s*(?!\$\{)[A-Za-z0-9+\/=!@#%^&*]{12,}/.test(code);
    },
    message: 'SECRET_LEAK_01: Potential plaintext secret in YAML. Use K8s Secret references (${SECRET_NAME}) or Spring Cloud Config encrypted properties. Never commit credentials.',
  },
  {
    id: 'FEIGN_AUTH_01',
    severity: 'high',
    appliesTo: ['.java'],
    check: (code) => {
      const hasFeignClient = /@FeignClient/.test(code);
      // OK if there's a RequestInterceptor or OAuth2 configuration or JWT forwarding
      const hasAuthPropagation = /RequestInterceptor|Authorization|BearerTokenRequestInterceptor|OAuth2FeignRequestInterceptor|feign\.oauth2/.test(code);
      return hasFeignClient && !hasAuthPropagation;
    },
    message: 'FEIGN_AUTH_01: @FeignClient detected without Authorization header propagation. Add a RequestInterceptor bean that forwards the JWT Bearer token for service-to-service calls.',
  },
  {
    id: 'OWASP_VERSION_01',
    severity: 'medium',
    appliesTo: ['.xml'],
    check: (code) => {
      // Detects <version> tags with literal version numbers inside <dependency> blocks
      // that are NOT inside <dependencyManagement> (those are intentional)
      const hasDepsBlock = /<dependencies>[\s\S]*?<\/dependencies>/.test(code);
      const hasLiteralVersion = /<version>[0-9]+\.[0-9]+[^<]*<\/version>/.test(code);
      const hasManagedDeps = /<dependencyManagement>/.test(code);
      return hasDepsBlock && hasLiteralVersion && !hasManagedDeps;
    },
    message: 'OWASP_VERSION_01: Dependency with hardcoded version in pom.xml. Prefer version management via the parent BOM (owasp-main) to ensure coordinated vulnerability patching.',
  },
  {
    id: 'CORS_POLICY_01',
    severity: 'medium',
    appliesTo: ['.java'],
    check: (code) => /@CrossOrigin\s*\(\s*origins\s*=\s*"\*"/.test(code),
    message: 'CORS_POLICY_01: Wildcard @CrossOrigin origins detected. STaaS APIs should restrict CORS to known frontend domains (mobilitymarketplace.io, boschindia-mobilitysolutions.com).',
  },
];

export function verifySecurityCompliance(code: string, fileExtension: string): SecurityVerifyResult {
  const ext = fileExtension.startsWith('.') ? fileExtension : `.${fileExtension}`;
  const applicable = SECURITY_RULES.filter(r => r.appliesTo.includes(ext));
  const violations: SecurityViolation[] = [];

  for (const rule of applicable) {
    try {
      if (rule.check(code)) {
        violations.push({ rule: rule.id, severity: rule.severity, message: rule.message });
      }
    } catch {
      // Regex errors should never fail the verification — skip the rule
    }
  }

  const criticals = violations.filter(v => v.severity === 'critical').length;
  const highs = violations.filter(v => v.severity === 'high').length;
  const mediums = violations.filter(v => v.severity === 'medium').length;
  const passed = criticals === 0 && highs === 0;

  let summary: string;
  if (passed && mediums === 0) {
    summary = 'Security verification PASSED — no violations detected.';
  } else if (passed) {
    summary = `Security verification PASSED with ${mediums} medium advisory note(s). Review before merging.`;
  } else {
    summary = `Security verification FAILED: ${criticals} critical, ${highs} high, ${mediums} medium violation(s). Fix before writing to disk.`;
  }

  return { violations, passed, summary };
}
```

---

### γ-4 · Wire Phase γ Indexers into `_scanWorkspace()`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

**Edit 4a — Add imports:**

```typescript
import { indexTerraformResources } from './terraformIndexer.js';
import { indexGitlabPipelines } from './gitlabCiIndexer.js';
```

**Edit 4b — Append to STaaS try/catch block** (after config drift section):

```typescript
// ── Phase γ: Terraform IaC ────────────────────────────────────────────────
const tfResult = indexTerraformResources(workspaceRoot);
if (tfResult.fileCount > 0) {
  profile.terraformSummary = {
    resourceCount: tfResult.resources.length,
    providers: tfResult.providers,
    fileCount: tfResult.fileCount,
    // Surface top resource types for agent context
    topResourceTypes: [...new Set(tfResult.resources.map(r => r.resourceType))]
      .slice(0, 10),
  };
  this._metricsService.capture('STaaS Terraform Indexed', {
    fileCount: tfResult.fileCount,
    resourceCount: tfResult.resources.length,
  });
}

// ── Phase γ: GitLab CI Pipeline ──────────────────────────────────────────
const ciResult = indexGitlabPipelines(workspaceRoot);
if (ciResult.fileCount > 0) {
  profile.pipelineSummary = {
    stageCount: ciResult.stages.length,
    jobCount: ciResult.jobs.length,
    hasManualGates: ciResult.hasManualGates,
    stages: ciResult.stages.map(s => s.name),
  };
  this._metricsService.capture('STaaS CI Indexed', {
    fileCount: ciResult.fileCount,
    jobCount: ciResult.jobs.length,
  });
}
```

---

### γ-5 · Extend `WorkspaceProfile` with Phase γ Fields

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts`

Append to `WorkspaceProfile`:

```typescript
/** Terraform IaC resource summary */
terraformSummary?: TerraformSummary | null;
/** GitLab CI pipeline structure summary */
pipelineSummary?: PipelineSummary | null;
```

Add types:

```typescript
export type TerraformSummary = {
  resourceCount: number;
  providers: string[];
  fileCount: number;
  topResourceTypes: string[];
};

export type PipelineSummary = {
  stageCount: number;
  jobCount: number;
  hasManualGates: boolean;
  stages: string[];
};
```

---

### γ-6 · Extend `serializeWorkspaceProfileForPrompt()` with Phase γ Blocks

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

After the config drift block added in β-6, append:

```typescript
// ── Terraform IaC Context ──────────────────────────────────────────────
if (mode === 'agent' && profile.terraformSummary) {
  const tf = profile.terraformSummary;
  lines.push(
    `\nInfrastructure (Terraform): ${tf.resourceCount} resources across ${tf.fileCount} .tf files` +
    ` | Providers: ${tf.providers.join(', ')}` +
    (tf.topResourceTypes.length > 0 ? ` | Types: ${tf.topResourceTypes.slice(0, 6).join(', ')}` : '')
  );
}

// ── CI/CD Pipeline Context ─────────────────────────────────────────────
if (mode === 'agent' && profile.pipelineSummary) {
  const ci = profile.pipelineSummary;
  lines.push(
    `\nCI/CD: ${ci.stageCount} stages (${ci.stages.join(' → ')}), ${ci.jobCount} jobs` +
    (ci.hasManualGates ? ' | Manual approval gate present for prod deployments' : '')
  );
}
```

---

### γ-7 · Register Phase γ Tools (3-File Pattern)

**Tool: `verify_security_compliance`**

**`toolsServiceTypes.ts`** — add:
```typescript
'verify_security_compliance': { code: string; fileExtension: string },
// Result:
'verify_security_compliance': {
  violations: { rule: string; severity: string; message: string }[];
  passed: boolean;
  summary: string;
},
```

**`prompts.ts`** — add to `builtinTools`:
```typescript
verify_security_compliance: {
  name: 'verify_security_compliance',
  description: `Run STaaS security compliance checks on generated or modified code BEFORE writing it to disk.
Detects: missing tenant isolation in @Query methods (CRITICAL), unsecured @RestController endpoints (HIGH),
hardcoded JWKS URIs (HIGH), plaintext secrets in YAML (CRITICAL), missing Feign auth propagation (HIGH),
bare dependency versions bypassing OWASP BOM (MEDIUM), and wildcard CORS origins (MEDIUM).
ALWAYS call this tool after generating any .java controller, Feign client, application-{env}.yml, or pom.xml.`,
  params: {
    code: { description: 'The complete code content to check.' },
    file_extension: { description: 'File extension determining which rules apply: .java, .yml, .yaml, or .xml' },
  },
},
```

**`toolsService.ts`** — add to `validateParams`:
```typescript
verify_security_compliance: (params: RawToolParamsObj) => ({
  code: validateStr('code', params.code),
  fileExtension: validateStr('fileExtension', params.file_extension ?? params.fileExtension),
}),
```
Add to `callTool`:
```typescript
verify_security_compliance: async ({ code, fileExtension }) => {
  const { verifySecurityCompliance } = await import('./securityVerifierTool.js');
  const result = verifySecurityCompliance(code, fileExtension);
  return { result };
},
```
Add to `stringOfResult`:
```typescript
verify_security_compliance: (_p, result) => {
  if (result.violations.length === 0) return result.summary;
  const lines = [result.summary, ''];
  for (const v of result.violations) {
    lines.push(`[${v.severity.toUpperCase()}] ${v.rule}: ${v.message}`);
  }
  return lines.join('\n');
},
```

---

### γ-8 · ONDC Protocol Context Injection

This is a prompt-only change — no indexer or DB table required.

**File:** `src/vs/workbench/contrib/trove/common/prompt/prompts.ts`

**Edit 8a — Add `activeURI` to `ChatSystemMessageOpts`** (it is already present in the
`chat_systemMessage_volatile` opts but not `_stable`). Add `activeURI?: string` to
`ChatSystemMessageOpts`:

```typescript
type ChatSystemMessageOpts = {
  // ... existing fields ...
  activeURI?: string;  // add this field
};
```

**Edit 8b — Add ONDC context block inside `chat_systemMessage_stable()`**, after the `memoryBlock`
push and before `ansStrs.push(header)`:

```typescript
// Inject ONDC context when active file is inside an ONDC integrator service
if (opts.activeURI && (
  opts.activeURI.includes('ondc-integrator') ||
  opts.activeURI.includes('ondc_integrator')
)) {
  const ondcBlock = `<ondc_protocol_context>
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
  ansStrs.splice(ansStrs.indexOf(header), 0, ondcBlock);
}
```

**Edit 8c — Thread `activeURI` through the call site.** The `chat_systemMessage` function calls
`chat_systemMessage_stable`. Locate its call in `convertToLLMMessageService.ts` and pass
`activeURI: opts.activeURI` into the stable options object.

---

### γ-9 · Phase γ Tests

**File:** `src/vs/workbench/contrib/trove/browser/test/securityVerifierTool.test.ts`

```typescript
import * as assert from 'assert';
import { verifySecurityCompliance } from '../securityVerifierTool.js';

suite('SecurityVerifierTool', () => {

  test('flags missing tenant filter in Java @Query', () => {
    const code = `
@Repository
public interface OrderRepo extends JpaRepository<Order, Long> {
  @Query("SELECT o FROM Order o WHERE o.status = :status")
  List<Order> findByStatus(@Param("status") String status);
}`;
    const result = verifySecurityCompliance(code, '.java');
    const rule = result.violations.find(v => v.rule === 'TENANT_ISOLATION_01');
    assert.ok(rule, 'Should flag TENANT_ISOLATION_01');
    assert.strictEqual(rule.severity, 'critical');
  });

  test('passes when tenantId filter is present', () => {
    const code = `
@Query("SELECT o FROM Order o WHERE o.tenantId = :tenantId AND o.status = :status")
List<Order> findByStatus(@Param("tenantId") String tenantId, @Param("status") String status);`;
    const result = verifySecurityCompliance(code, '.java');
    const rule = result.violations.find(v => v.rule === 'TENANT_ISOLATION_01');
    assert.ok(!rule, 'Should NOT flag when tenantId is present');
  });

  test('flags unsecured @RestController', () => {
    const code = `
@RestController
@RequestMapping("/order")
public class OrderController {
  @GetMapping("/{id}")
  public OrderResponse getOrder(@PathVariable Long id) { return null; }
}`;
    const result = verifySecurityCompliance(code, '.java');
    const rule = result.violations.find(v => v.rule === 'JWT_VALIDATION_01');
    assert.ok(rule, 'Should flag JWT_VALIDATION_01');
  });

  test('flags plaintext secret in YAML', () => {
    const code = `
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-secret: myS3cr3tK3y123456
`;
    const result = verifySecurityCompliance(code, '.yml');
    const rule = result.violations.find(v => v.rule === 'SECRET_LEAK_01');
    assert.ok(rule, 'Should flag SECRET_LEAK_01');
    assert.strictEqual(rule.severity, 'critical');
  });

  test('passes Spring expression placeholder secrets', () => {
    const code = `
spring:
  security:
    oauth2:
      client:
        registration:
          keycloak:
            client-secret: ${'{KEYCLOAK_SECRET}'}
`;
    const result = verifySecurityCompliance(code, '.yml');
    const rule = result.violations.find(v => v.rule === 'SECRET_LEAK_01');
    assert.ok(!rule, 'Should NOT flag ${...} placeholder secrets');
  });
});
```

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/terraformIndexer.test.ts`

```typescript
import * as assert from 'assert';
import { indexTerraformResources } from '../terraformIndexer.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

suite('TerraformIndexer', () => {
  let tempDir: string;

  setup(() => {
    tempDir = join(tmpdir(), `trove-tf-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  teardown(() => { try { rmSync(tempDir, { recursive: true }); } catch {} });

  test('indexes azurerm resources', () => {
    writeFileSync(join(tempDir, 'main.tf'), `
resource "azurerm_kubernetes_cluster" "aks_prod" {
  name = "staas-prod-aks"
  location = "East US"
}

resource "azurerm_redis_cache" "cache" {
  name = "staas-redis"
}
`);
    const result = indexTerraformResources(tempDir);
    assert.strictEqual(result.resources.length, 2);
    assert.ok(result.providers.includes('azurerm'));
    assert.strictEqual(result.fileCount, 1);
  });

  test('detects provider declarations', () => {
    writeFileSync(join(tempDir, 'providers.tf'), `
provider "azurerm" {
  features {}
}
provider "azuread" {}
`);
    const result = indexTerraformResources(tempDir);
    assert.ok(result.providers.includes('azurerm'));
    assert.ok(result.providers.includes('azuread'));
  });
});
```

---

## Complete Summary: All Files and Touch Points

### New Files (14 total)

```
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/javaSpringIndexer.ts          Phase α
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/mavenDependencyIndexer.ts     Phase α
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/kubernetesYamlIndexer.ts      Phase α
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/gatewayRouteIndexer.ts        Phase α
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/npmImpactIndexer.ts           Phase β
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/configEnvIndexer.ts           Phase β
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/terraformIndexer.ts           Phase γ
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/gitlabCiIndexer.ts            Phase γ
src/vs/workbench/contrib/trove/browser/securityVerifierTool.ts                              Phase γ
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/javaSpringIndexer.test.ts
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/mavenDependencyIndexer.test.ts
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/kubernetesYamlIndexer.test.ts
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/gatewayRouteIndexer.test.ts
src/vs/workbench/contrib/trove/browser/test/securityVerifierTool.test.ts
src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/terraformIndexer.test.ts
```

### Modified Files (7 total)

```
repoIntelligenceDb.ts         SCHEMA_VERSION 2→4, 9 new tables, 16 new public methods, 9 type exports
repoIntelligenceTypes.ts      WorkspaceProfile: 6 new optional fields; IRepoIntelligenceMainService: 5 new methods; 8 new exported types
repoIntelligenceService.impl.ts  _scanWorkspace(): 8-indexer STaaS block; 7 new service method implementations
codeChunker.ts                Java entry in SYMBOL_PATTERNS and LANGUAGE_BOUNDARIES
toolsServiceTypes.ts          8 new BuiltinToolCallParams + BuiltinToolResultType entries
prompts.ts                    8 new builtinTools; serializeWorkspaceProfileForPrompt extended; ONDC block; char budget 4800→8000
toolsService.ts               8×3 = 24 new entries across validateParams, callTool, stringOfResult
```

### New Tools Registered (8 total)

| Tool | Phase | Purpose | Trigger condition |
|---|---|---|---|
| `query_service_topology` | α | Service mesh graph queries | Before editing any Spring Boot service |
| `resolve_api_contract` | α | Gateway → controller → DTO trace | Before generating frontend API calls |
| `get_maven_impact` | α | Maven shared lib blast radius | Before editing dependencies-be/ |
| `get_npm_impact` | β | @mobilitystore/* blast radius | Before editing shared frontend libs |
| `get_config_drift` | β | Env config diff for a service | Before editing application-{env}.yml |
| `verify_security_compliance` | γ | Pre-write security rule check | After generating .java/.yml/.xml |
| *(γ-future)* `get_iac_topology` | γ | Terraform resource query | Before adding Azure resources |
| *(γ-future)* `get_pipeline_blast_radius` | γ | CI stage impact estimate | Before pushing breaking changes |

### 30-Step Execution Order for Cursor AI

Execute in this exact order. Each numbered step is atomically compilable.

```
 1.  repoIntelligenceDb.ts        — SCHEMA_VERSION bump + α tables + α type exports + α DB methods
 2.  repoIntelligenceTypes.ts     — WorkspaceProfile α fields + IRepoIntelligenceMainService α sigs + α types
 3.  javaSpringIndexer.ts         — NEW FILE
 4.  mavenDependencyIndexer.ts    — NEW FILE
 5.  kubernetesYamlIndexer.ts     — NEW FILE
 6.  gatewayRouteIndexer.ts       — NEW FILE
 7.  codeChunker.ts               — Java SYMBOL_PATTERNS + LANGUAGE_BOUNDARIES
 8.  repoIntelligenceService.impl.ts  — α imports + α STaaS block in _scanWorkspace() + 3 α methods
 9.  toolsServiceTypes.ts         — 3 α tool type pairs
10.  prompts.ts                   — 3 α builtinTools + serializeWorkspaceProfileForPrompt α blocks + char budget
11.  toolsService.ts              — 3 α tool implementations (validateParams + callTool + stringOfResult)
12.  [COMPILE CHECK α — run: node_modules/.bin/tsc --noEmit --project src/tsconfig.json]
13.  repoIntelligenceDb.ts        — SCHEMA_VERSION 3→4 + β tables + β type exports + β DB methods
14.  repoIntelligenceTypes.ts     — WorkspaceProfile β fields + IRepoIntelligenceMainService β sigs + β types
15.  npmImpactIndexer.ts          — NEW FILE
16.  configEnvIndexer.ts          — NEW FILE
17.  repoIntelligenceService.impl.ts  — β imports + β append to STaaS block + 2 β methods
18.  toolsServiceTypes.ts         — 2 β tool type pairs
19.  prompts.ts                   — 2 β builtinTools + serializeWorkspaceProfileForPrompt β blocks
20.  toolsService.ts              — 2 β tool implementations
21.  [COMPILE CHECK β]
22.  repoIntelligenceTypes.ts     — WorkspaceProfile γ fields + γ types
23.  terraformIndexer.ts          — NEW FILE
24.  gitlabCiIndexer.ts           — NEW FILE
25.  securityVerifierTool.ts      — NEW FILE (browser/)
26.  repoIntelligenceService.impl.ts  — γ imports + γ append to STaaS block
27.  toolsServiceTypes.ts         — verify_security_compliance type pair
28.  prompts.ts                   — verify_security_compliance builtinTool + ONDC block + activeURI field
29.  toolsService.ts              — verify_security_compliance implementation
30.  [COMPILE CHECK γ — then write all test files]
```

---

*End of STaaS ↔ Trove v1 Integration Implementation Plan*
*Repository cloned from: https://github.com/hari8g/trove_v1.git*
*All file paths verified against live repository structure.*
