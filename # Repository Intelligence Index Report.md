# Repository Intelligence Index Report
Workspace: `/Users/harig/Desktop/trove_v1`
Generated: 6/23/2026, 9:46:07 PM
Profile last scanned: 6/22/2026, 11:06:53 PM
Status: **Ready**
## How parsing works (Tree-sitter vs RIAF)
**Important:** Repository Intelligence (RIAF) does **not** use Tree-sitter for indexing.
| Layer | Technology | Purpose |
| --- | --- | --- |
| Editor syntax highlighting | VS Code Tree-sitter WASM (`@vscode/tree-sitter-wasm`) | Accurate token colors in the editor |
| RIAF chunk + symbol index | Regex boundary patterns per language | Fast, dependency-free semantic search (`search_codebase`, `search_symbols`) |
| RIAF STaaS indexers | Regex / structured text parsers | Spring, Maven, K8s, Terraform, GitLab CI, gateway routes, config drift |
Tree-sitter in the editor and RIAF indexing are independent. Good syntax highlighting does **not** imply RIAF has AST-level understanding of your code.
### RIAF chunking pipeline
1. **Workspace scan** — file extensions, LOC, frameworks, build commands.
2. **Chunk extraction** — splits source files on language-specific regex boundaries (functions, classes, blocks). Skips: CSS, HTML, JSON, Less, Markdown, SCSS, Sass, TOML, YAML.
3. **FTS index** — SQLite FTS5 (`chunks_fts`) powers BM25-ranked `search_codebase`.
4. **Symbol extraction** — incremental regex pass on changed files; stored in `symbols` + `symbols_fts`.
5. **STaaS indexers** — run during profile scan when matching artifacts are found.
## Index quality summary
| Metric | Value | Assessment |
| --- | --- | --- |
| Semantic search coverage | 5,756 / 5,836 indexable files (99%) | **Strong** — Most indexable files are represented in semantic search. |
| Code chunks | 32,380 | Indexed for semantic search |
| Symbols | 42 across 11 files | **Limited** — Only a small number of symbols were extracted. Nested or non-standard declarations may be missed by regex patterns. |
| Total scanned files | 7,849 | Includes config, docs, assets |
## Workspace profile
- **Languages:** TypeScript, JSON, CSS, JavaScript, Markdown
- **Frameworks:** React, Playwright, Electron, Mocha, Next.js, Tailwind CSS, Webpack
- **LOC:** 2,611,020 across 7,849 files
## Chunks by type
- **class**: 15,111
- **function**: 8,005
- **block**: 7,917
- **file**: 1,347
## Files by language (scan metadata)
- **TypeScript**: 5,532
- **JSON**: 886
- **Unknown**: 723
- **CSS**: 274
- **JavaScript**: 142
- **Markdown**: 73
- **Rust**: 71
- **Shell**: 51
- **HTML**: 40
- **Python**: 7
- **YAML**: 7
- **C++**: 6
- _…and 22 more_
## Chunks by language
- **TypeScript**: 31,371
- **Rust**: 626
- **JavaScript**: 289
- **Shell**: 45
- **Python**: 15
- **C++**: 6
- **XML**: 5
- **Java**: 4
- **PHP**: 2
- **Perl**: 2
- **C**: 1
- **C#**: 1
- _…and 13 more_
## Symbols by language
- **TypeScript**: 42
## STaaS / polyglot indexers
- **Spring REST endpoints**: not detected — regex scan of `@RestController` Java files
- **Feign client edges**: not detected — inter-service call graph hints
- **Maven dependencies**: not detected — pom.xml consumer → artifact edges
- **Gateway routes**: not detected — Spring Cloud Gateway YAML / properties
- **Kubernetes manifests**: not detected — Deployment/Service/Ingress YAML
- **NPM package edges**: not detected — shared internal package consumers
- **Config env drift**: not detected — multi-environment property differences
- **Terraform resources**: not detected — `.tf` resource blocks
- **GitLab CI jobs**: not detected — `.gitlab-ci.yml` stage/job graph
## Known limitations
- Regex chunking may split nested or generated code imperfectly.
- Symbols miss arrow functions, anonymous classes, and non-top-level declarations.
- STaaS indexers are heuristic; validate critical routes and dependencies manually.
---
_Click the status bar index indicator anytime to refresh this report._
