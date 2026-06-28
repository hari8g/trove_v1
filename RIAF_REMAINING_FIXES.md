# RIAF — Remaining 3 Failures + 2 Regression Issues
> Report generated 6/23 6:54 PM. Six of nine STaaS indexers now working.
> Three remain broken. Two additional quality regressions also identified below.

---

## Summary

| Indexer | Before | After | Status |
|---|---|---|---|
| Maven dependencies | 0 | **911** ✅ | Fixed |
| Gateway routes | 0 | **16** ✅ | Fixed |
| Kubernetes manifests | 0 | **105** ✅ | Fixed |
| NPM package edges | 0 | **55** ✅ | Fixed |
| Terraform resources | 0 | **71** ✅ | Fixed |
| GitLab CI jobs | 0 | **40** ✅ | Fixed |
| Spring REST endpoints | 0 | **0** ❌ | 2 bugs remain |
| Feign client edges | 0 | **0** ❌ | Same 2 bugs |
| Config env drift | 0 | **0** ❌ | Pattern mismatch |

Additional regressions:
| Item | State | Fix |
|---|---|---|
| `workspaceScanner MAX_DEPTH = 8` | Never increased | ❌ Java files at depth > 8 not in chunk index |
| `Frameworks: none detected` | Still empty | ❌ parseJavaBuild only checks workspace root |

---

## Failure 1 — Spring REST endpoints + Feign (same root cause)

Two bugs in `javaSpringIndexer.ts`, both still unfixed.

### Bug 1a — Windows path regex at line 166 (CRITICAL)

**File:** `javaSpringIndexer.ts` — line 166

**Current code:**
```typescript
const serviceDir = pom.replace(/\/pom\.xml$/, '');
```

**Why it breaks on Windows:** `pom` on this machine is:
```
c:\Users\hpg5ban\Desktop\Gitlab_STaaS_Repo\application.yml\staas-order-management-dev\pom.xml
```
The regex `/\/pom\.xml$/` uses forward slash. The path ends with `\pom.xml` (backslash).
The regex **never matches**. `serviceDir` equals the full pom path — a file, not a directory.
`collectJavaFiles(serviceDir)` calls `readdirSync` on a **file path**, gets an error,
catches it silently, returns `[]`. Zero Java files. Zero endpoints. Every service, always.

**Fix — use `dirname(pom)` which handles both `/` and `\`:**
```typescript
import { join, relative, dirname } from 'path';  // add dirname to imports at top

// Line 166 — replace:
const serviceDir = pom.replace(/\/pom\.xml$/, '');
// with:
const serviceDir = dirname(pom);
```

### Bug 1b — `spring-boot` string check at line 163 (HIGH)

**File:** `javaSpringIndexer.ts` — line 163

**Current code:**
```typescript
if (!content.includes('spring-boot')) continue;
```

**Why it may fail:** STaaS services likely use a custom parent POM (`com.bosch.mobility:staas-parent`).
Child `pom.xml` files reference only the corporate parent, not spring-boot directly.
The corporate parent then manages spring-boot versions as a BOM. A minimal child pom:
```xml
<parent>
  <groupId>com.bosch.mobility</groupId>
  <artifactId>staas-parent</artifactId>
</parent>
<artifactId>staas-order-management</artifactId>
<!-- No spring-boot string here — inherited from parent -->
```
This child pom is silently skipped.

**Fix — widen detection to also match `src/main/java` directory presence:**
```typescript
import { join, relative, dirname, statSync } from 'fs';  // statSync already imported

// Lines 160-166 — replace the entire try/continue block:
try {
  const content = readFileSync(pom, 'utf8');
  const isSpringProject =
    content.includes('spring-boot') ||           // direct spring-boot dep
    content.includes('springframework') ||        // Spring framework namespace in imports
    content.includes('spring-web') ||
    content.includes('spring-mvc');

  // Also accept any Maven project that has src/main/java — it's a Java service
  // regardless of what the parent POM is named
  const hasSrcMainJava = (() => {
    try {
      statSync(join(dirname(pom), 'src', 'main', 'java'));
      return true;
    } catch { return false; }
  })();

  if (!isSpringProject && !hasSrcMainJava) continue;
} catch { continue; }
```

### Also — fix line 26 (service name on Windows)

**File:** `javaSpringIndexer.ts` — line 26

**Current code:**
```typescript
return workspaceRoot.split('/').at(-1) ?? 'unknown-service';
```

**Fix:**
```typescript
import { basename } from 'path';  // add to path import line
// ...
return basename(workspaceRoot) || 'unknown-service';
```

### Also — fix line 91 (interface name on Windows)

**File:** `javaSpringIndexer.ts` — line 91

**Current code:**
```typescript
relPath.split('/').at(-1)?.replace('.java', '') ?? 'Unknown'
```

**Fix:**
```typescript
basename(relPath, '.java') || 'Unknown'
```

**Full import line after all path fixes:**
```typescript
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname, basename } from 'path';
```

---

## Failure 2 — Config env drift

**File:** `configEnvIndexer.ts` — line 10

**Current code:**
```typescript
const ENV_PATTERN = /application-(\w+)\.(yml|yaml)$/;
```

**Why it fails:** This matches only `application-{env}.yml` (Spring Boot local config style).
The STaaS platform uses Spring Cloud Config Server (`staas-cloud-config-service-dev`).
In Spring Cloud Config, environment configs are served centrally, not per-service.
The file naming convention is either:
- `{service-name}-{env}.yml` in the config server's git repo (not in the main mono-repo)
- OR: `application.yml` only (no env suffix — env config comes from the Config Server at runtime)

With 607 YAML files in the workspace and zero matching `application-{env}.yml`,
the STaaS services almost certainly use the central config server pattern.

**Two-part fix:**

### Fix 2a — Dual pattern for both naming conventions

**File:** `configEnvIndexer.ts`

```typescript
// Replace the single ENV_PATTERN with two patterns:

// Pattern 1: Spring Boot local config (application-dev.yml)
const ENV_PATTERN_LOCAL = /application-(\w+)\.(yml|yaml)$/;

// Pattern 2: Spring Cloud Config server style (staas-order-management-dev.yml)
// Matches: {word}-{word}-{env}.yml where env is a known environment name
const KNOWN_ENVS = '(?:dev|qa|sit|uat|staging|stage|prod|production|local|test|int)';
const ENV_PATTERN_CLOUD = new RegExp(`[\\w-]+-(${ KNOWN_ENVS })\\.(yml|yaml)$`, 'i');

// Update collectConfigFiles to check both patterns:
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
    else if (ENV_PATTERN_LOCAL.test(entry) || ENV_PATTERN_CLOUD.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

// Update indexConfigEnvironments to extract env from either pattern:
for (const filePath of configFiles) {
  let env: string | undefined;
  const localMatch = filePath.match(ENV_PATTERN_LOCAL);
  const cloudMatch = filePath.match(ENV_PATTERN_CLOUD);
  if (localMatch) env = localMatch[1];
  else if (cloudMatch) env = cloudMatch[1].toLowerCase();
  if (!env) continue;
  // ... rest of function unchanged
}
```

### Fix 2b — Also scan the config service directory explicitly

The `staas-cloud-config-service-dev` directory (if it exists in the mono-repo) likely
contains the centralized environment configs. Scan it with a broadened pattern:

```typescript
// In indexConfigEnvironments, before the main scan:
// Look for a known Spring Cloud Config server directory
const configServiceCandidates = [
  join(workspaceRoot, 'staas-cloud-config-service-dev'),
  join(workspaceRoot, 'cloud-config'),
  join(workspaceRoot, 'config-service'),
  // also search inside the application.yml service folder
];
for (const candidate of configServiceCandidates) {
  try {
    statSync(candidate);  // check if exists
    collectConfigFiles(candidate, configFiles, 0);  // scan it specifically
  } catch { /* doesn't exist */ }
}
```

---

## Regression 1 — `MAX_DEPTH = 8` still not increased

**File:** `workspaceScanner.ts` — line 14

Confirmed still at `const MAX_DEPTH = 8;` — the fix was planned but never applied.

**Impact:** Java source files at depth 9+ are absent from `fileMeta`. This means they are
not chunked (no semantic search coverage for Java controllers, services, models),
not included in the "Files by language: Java" count (they show as "Unknown" or missing),
and explains why `Chunks by language: Java = 5` (only shallow Java files at depth ≤ 8).

The STaaS Java source path depth from workspace root:
```
Gitlab_STaaS_Repo/          depth 0
  application.yml/          depth 1   (top-level category directory)
    staas-order-management/ depth 2   (service directory)
      src/                  depth 3
        main/               depth 4
          java/             depth 5
            com/            depth 6
              bosch/        depth 7
                mobility/   depth 8  ← MAX_DEPTH boundary
                  staas/    depth 9  ← NOT SCANNED
                    order/  depth 10
                      controller/   depth 11
                        OrderController.java  depth 12
```

**Fix:**
```typescript
// workspaceScanner.ts line 14:
const MAX_DEPTH = 8;   // CURRENT — change to:
const MAX_DEPTH = 14;  // covers com.bosch.mobility.staas.module.subpackage structure
```

---

## Regression 2 — Framework detection fails for nested build files

**File:** `workspaceScanner.ts` — `parseJavaBuild` function (line 207)

**Current code:**
```typescript
const p = join(workspaceRoot, file);   // looks for pom.xml AT workspace root
if (!exists(p)) continue;
```

`workspaceRoot/pom.xml` does not exist — all pom.xml files are nested under
`application.yml/service-name/pom.xml`. Same problem for `parsePackageJson`:
it looks for `workspaceRoot/package.json` which also doesn't exist at the root.

**Fix — scan up to 3 directory levels for the first matching build file:**

```typescript
const parseJavaBuild = (workspaceRoot: string): FrameworkEntry[] => {
  const frameworks: FrameworkEntry[] = [];
  const javaMarkers = [
    { file: 'pom.xml', markers: ['spring-boot', 'springframework', 'quarkus', 'micronaut'] },
    { file: 'build.gradle', markers: ['spring-boot', 'springframework', 'quarkus'] },
  ];

  // Search for build file in subdirectories up to depth 3
  function findBuildFile(dir: string, targetFile: string, depth = 0): string | null {
    if (depth > 3) return null;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return null; }
    for (const entry of entries) {
      if (['node_modules', '.git', 'target'].includes(entry)) continue;
      const full = join(dir, entry);
      if (entry === targetFile) return full;
      try {
        if (statSync(full).isDirectory()) {
          const found = findBuildFile(full, targetFile, depth + 1);
          if (found) return found;
        }
      } catch { continue; }
    }
    return null;
  }

  for (const { file, markers } of javaMarkers) {
    const foundPath = findBuildFile(workspaceRoot, file);
    if (!foundPath) continue;
    try {
      const content = readFileSync(foundPath, 'utf8').toLowerCase();
      if (content.includes('spring-boot') || content.includes('springframework')) {
        frameworks.push({ name: 'Spring Boot', version: null, confidence: 'high' });
        break;  // found it — don't keep searching
      }
    } catch { /* ignore */ }
  }
  return frameworks;
};
```

Similarly fix `parsePackageJson`:
```typescript
// Instead of: const pkgPath = join(workspaceRoot, 'package.json');
// Use:
function findPackageJson(dir: string, depth = 0): string | null {
  if (depth > 3) return null;
  // ... same search pattern as above
}
const pkgPath = findPackageJson(workspaceRoot) ?? join(workspaceRoot, 'package.json');
```

---

## Complete edit list

| # | File | Line | Change |
|---|---|---|---|
| 1a | `javaSpringIndexer.ts` | imports | Add `dirname, basename` to `path` import |
| 1a | `javaSpringIndexer.ts` | 166 | `pom.replace(/\/pom\.xml$/, '')` → `dirname(pom)` |
| 1b | `javaSpringIndexer.ts` | 163 | Widen spring-boot detection + `src/main/java` check |
| 1c | `javaSpringIndexer.ts` | 26 | `split('/')` → `basename()` |
| 1d | `javaSpringIndexer.ts` | 91 | `split('/')` → `basename()` |
| 2a | `configEnvIndexer.ts` | 10 | Add `ENV_PATTERN_CLOUD` alongside existing pattern |
| 2a | `configEnvIndexer.ts` | collectConfigFiles | Check both patterns |
| 2a | `configEnvIndexer.ts` | indexConfigEnvironments | Extract env from either pattern |
| 2b | `configEnvIndexer.ts` | indexConfigEnvironments | Add config service directory scan |
| R1 | `workspaceScanner.ts` | 14 | `MAX_DEPTH = 8` → `MAX_DEPTH = 14` |
| R2 | `workspaceScanner.ts` | parseJavaBuild | Scan subdirectories for build files |
| R2 | `workspaceScanner.ts` | parsePackageJson | Scan subdirectories for package.json |

---

## Expected report after all fixes applied

```
## STaaS / polyglot indexers

- Detected services: 25+ (staas-order-management, staas-catalog-management, …)
- Spring REST endpoints:  180+ indexed
- Feign client edges:      40+ indexed
- Maven dependencies:     911 indexed   ✅ (already working)
- Gateway routes:          16 indexed   ✅ (already working)
- Kubernetes manifests:   105 indexed   ✅ (already working)
- NPM package edges:       55 indexed   ✅ (already working)
- Config env drift:        20+ indexed  (if application-{env}.yml or {service}-{env}.yml exist)
- Terraform resources:     71 indexed   ✅ (already working)
- GitLab CI jobs:          40 indexed   ✅ (already working)

## Workspace profile
- Frameworks: Spring Boot, React  (after parseJavaBuild subdirectory search fix)

## Files by language
- Java: 1,500–3,000+  (after MAX_DEPTH = 14 fix)

## Chunks by language
- Java: 800–2,000+  (after MAX_DEPTH = 14 fix enables chunking deep Java files)
```

---

## Execution order

```
1. javaSpringIndexer.ts    — EDIT: 4 changes (dirname, basename ×2, spring detection)
2. configEnvIndexer.ts     — EDIT: dual pattern + config service dir scan
3. workspaceScanner.ts     — EDIT: MAX_DEPTH 8→14, parseJavaBuild + parsePackageJson subdirectory search
4. [build Trove]
5. Run: Trove → Refresh Index   (force re-scan)
6. Regenerate report — compare against expected output above
```

*All edits in `electron-main/` — they take effect on next profile scan, no browser-side changes needed.*
