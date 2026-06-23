# RIAF Index — 7 Root Cause Fixes
> All edits reference the live repository. Apply all 5 code fixes, rebuild, then force a re-scan.

---

## Fix 1 (Immediate) — Force a fresh profile scan

No code change. The profile from 6/22 predates the STaaS indexer wiring.
`REPO_INTEL_PROFILE_STALE_MS = 24h` — the profile is at the edge of expiry but is still served
from cache. Run one of these:

**Option A (Trove UI):** Click the RIAF status bar indicator → "Refresh index"

**Option B (Command palette):** `Ctrl+Shift+P` → `Trove: Analyse Repository`

**Option C (Code — force stale then rescan):**
```typescript
// In browser devtools or a one-off debug action:
repoIntelligenceService.refreshProfile(workspaceRoot);
```

After the re-scan, click the status bar indicator again to regenerate the report.
If the 5 code fixes below are applied and Trove rebuilt first, this single re-scan will
populate all STaaS tables.

---

## Fix 2 (Critical) — Windows path: `serviceDir` extraction

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/javaSpringIndexer.ts`
**Line 166**

**Problem:** `pom.replace(/\/pom\.xml$/, '')` uses a forward-slash regex. On Windows,
`pom` is `c:\Users\...\application.yml\staas-order-management\pom.xml`. The regex never
matches `\pom.xml`, so `serviceDir` equals the full pom path — the Java indexer then tries
to scan a non-existent directory and returns 0 endpoints for every service.

**Before:**
```typescript
const serviceDir = pom.replace(/\/pom\.xml$/, '');
```

**After:**
```typescript
import { dirname } from 'path';
// ...
const serviceDir = dirname(pom);  // Node.js path.dirname handles both / and \
```

`dirname` is already imported in the file (it uses `join` and `relative` from `'path'`).
Add `dirname` to the existing import:
```typescript
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';  // add dirname
```

---

## Fix 3 (Critical) — Windows path: `split('/')` for name derivation

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/javaSpringIndexer.ts`
**Lines 26, 91, and any other `split('/')`**

**Problem:** `workspaceRoot.split('/').at(-1)` on a Windows path like
`c:\Users\hpg5ban\Desktop\Gitlab_STaaS_Repo` splits by `/` and gets the whole string
as a single element — the service name becomes the 200-character full path.

**Before (line 26):**
```typescript
return workspaceRoot.split('/').at(-1) ?? 'unknown-service';
```

**After:**
```typescript
import { basename } from 'path';
// ...
return basename(workspaceRoot) || 'unknown-service';
```

**Before (line 91):**
```typescript
const interfaceName = interfaceMatch ? interfaceMatch[1] : relPath.split('/').at(-1)?.replace('.java', '') ?? 'Unknown';
```

**After:**
```typescript
import { basename } from 'path';
// ...
const interfaceName = interfaceMatch ? interfaceMatch[1] : (basename(relPath, '.java') || 'Unknown');
```

Add `basename` to the path import line (alongside `dirname` from Fix 2):
```typescript
import { join, relative, dirname, basename } from 'path';
```

---

## Fix 4 (High) — K8s resources hardcoded to 0 in report builder

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceIndexingReport.ts`
**Line 62**

**Problem:** `k8sResources: 0` is a literal — even when the `k8s_resources` table has
hundreds of rows, the report always shows "not detected" for Kubernetes manifests.

This requires two changes:

### 4a — Add `k8sResourceCount` to `WorkspaceProfile`

**File:** `src/vs/workbench/contrib/trove/common/repoIntelligenceTypes.ts`

Append to the `WorkspaceProfile` type (after `pipelineSummary`):
```typescript
/** Number of K8s resources indexed (Deployments, Services, Ingresses, etc.) */
k8sResourceCount?: number;
```

### 4b — Populate it in `_hydrateStaasSummaries`

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/repoIntelligenceService.impl.ts`

Find `_hydrateStaasSummaries` (around line 267). Inside it, after the existing queries,
add a K8s count query. First add the DB method:

**File:** `repoIntelligenceDb.ts` — add method:
```typescript
async getK8sResourceCount(workspaceHash: string): Promise<number> {
  const row = await this._get<{ count: number }>(
    `SELECT COUNT(*) as count FROM k8s_resources WHERE workspace_hash = ?`,
    [workspaceHash],
  );
  return row?.count ?? 0;
}
```

Then in `_hydrateStaasSummaries`, after the existing `endpoints, feignClients, routes, ...` destructuring:
```typescript
const k8sCount = await this._db.getK8sResourceCount(hash);
// ...
if (k8sCount > 0) {
  hydrated = { ...hydrated, k8sResourceCount: k8sCount };
}
```

### 4c — Use it in the report builder

**File:** `repoIntelligenceIndexingReport.ts` — line 62, change:
```typescript
k8sResources: 0,
```
to:
```typescript
k8sResources: profile?.k8sResourceCount ?? 0,
```

---

## Fix 5 (High) — GitLab CI depth limit too shallow

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/gitlabCiIndexer.ts`
**Line 31**

**Problem:** `if (depth > 4) return results;` stops at depth 4. The STaaS
`auto-merge-template/` directory nests CI YAML templates up to depth 5+.
Service-level `.gitlab-ci.yml` files are at depth 2 (fine), but template files in
`auto-merge-template/service-pipeline-template/ci-templates/specific/pipeline.yml`
reach depth 4–5 and are missed.

**Before:**
```typescript
if (depth > 4) return results;
```

**After:**
```typescript
if (depth > 6) return results;
```

---

## Fix 6 (Medium) — Spring-boot detection misses custom parent POMs

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/javaSpringIndexer.ts`
**Line 163**

**Problem:** `content.includes('spring-boot')` skips `pom.xml` files where Spring Boot
is a transitive dependency via a custom corporate parent (`com.bosch.staas:staas-parent`).
The child pom may only reference `staas-parent` and have no direct `spring-boot` string.

**Before:**
```typescript
if (!content.includes('spring-boot')) continue;
```

**After — widen detection to also catch Spring namespace and `src/main/java`:**
```typescript
const isSpringProject =
  content.includes('spring-boot') ||          // direct spring-boot reference
  content.includes('springframework') ||       // Spring namespace in imports/deps
  content.includes('spring-web') ||            // spring-web dependency
  content.includes('spring-mvc');              // spring-mvc dependency

// Also accept any Maven project that has a Java source directory — if the
// pom.xml lives next to src/main/java/, it's a Java service regardless of Spring.
const hasSrcMainJava = (() => {
  try {
    statSync(join(dirname(pom), 'src', 'main', 'java'));
    return true;
  } catch { return false; }
})();

if (!isSpringProject && !hasSrcMainJava) continue;
```

`statSync` is already imported. `dirname` and `join` are imported from Fix 2.

---

## Fix 7 (Minor) — Workspace scanner max depth misses deep Java source trees

**File:** `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/workspaceScanner.ts`
**Line 14**

**Problem:** `const MAX_DEPTH = 8;` stops before reaching `.java` source files at
`Gitlab_STaaS_Repo/application.yml/staas-order-management/src/main/java/com/bosch/staas/...`
(depth 9–11). The STaaS indexers use their own FS walks (not affected by this), but chunk
count for Java stays very low (3 files, 5 chunks instead of hundreds).

**Before:**
```typescript
const MAX_DEPTH = 8;
```

**After:**
```typescript
const MAX_DEPTH = 12;
```

12 is sufficient for the deepest Java package paths (depth ~10) while staying well
below MAX_FILES = 50,000 which is the real guard against unbounded scans.

---

## Complete edit summary

| # | File | Line | Change |
|---|---|---|---|
| 2 | `javaSpringIndexer.ts` | 166 | `pom.replace(…)` → `dirname(pom)` |
| 2 | `javaSpringIndexer.ts` | imports | Add `dirname, basename` to path import |
| 3 | `javaSpringIndexer.ts` | 26 | `split('/')` → `basename()` |
| 3 | `javaSpringIndexer.ts` | 91 | `split('/')` → `basename()` |
| 4a | `repoIntelligenceTypes.ts` | WorkspaceProfile | Add `k8sResourceCount?: number` |
| 4b | `repoIntelligenceDb.ts` | (new method) | Add `getK8sResourceCount()` |
| 4b | `repoIntelligenceService.impl.ts` | `_hydrateStaasSummaries` | Call `getK8sResourceCount`, set field |
| 4c | `repoIntelligenceIndexingReport.ts` | 62 | `0` → `profile?.k8sResourceCount ?? 0` |
| 5 | `gitlabCiIndexer.ts` | 31 | `depth > 4` → `depth > 6` |
| 6 | `javaSpringIndexer.ts` | 163 | Broaden spring detection + `src/main/java` check |
| 7 | `workspaceScanner.ts` | 14 | `MAX_DEPTH = 8` → `MAX_DEPTH = 12` |

---

## After applying all fixes — expected report

```
## STaaS / polyglot indexers

- Detected services: 25 (staas-order-management, staas-catalog-management, …)
- Spring REST endpoints: 180+ indexed — regex scan of @RestController Java files
- Feign client edges:   40+ indexed — inter-service call graph hints
- Maven dependencies:  300+ indexed — pom.xml consumer → artifact edges
- Gateway routes:       20+ indexed — Spring Cloud Gateway YAML / properties
- Kubernetes manifests: 80+ indexed — Deployment/Service/Ingress YAML
- NPM package edges:    35+ indexed — shared internal package consumers
- Config env drift:     15+ indexed — multi-environment property differences
- Terraform resources:  12+ indexed — .tf resource blocks
- GitLab CI jobs:       25+ indexed — .gitlab-ci.yml stage/job graph
```

## Verification steps after re-scan

1. Open the status bar RIAF indicator → confirm "Profile last scanned" shows today's date.
2. Run `Trove: Open Indexing Report` → check each STaaS line is no longer "not detected".
3. In the chat, type: `query_service_topology query="list all services"` — should return
   service names from the Spring endpoint index.
4. Type: `get_maven_impact artifactId="ms-data-model"` — should return a list of consumer
   `pom.xml` paths.
5. Check the "Java" line in "Files by language" — should show hundreds of files, not 3.
