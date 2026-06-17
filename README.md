# Trove

Trove is an AI-native code editor built on [VS Code](https://github.com/microsoft/vscode). It adds a full agentic coding layer on top of the editor: multi-provider LLM chat, built-in tools (read, search, edit, terminal, web), inline diffs with checkpoints, codebase-aware autocomplete, and workspace intelligence — while keeping VS Code’s extension ecosystem and editing experience.

**Product version:** see `troveVersion` in [`product.json`](product.json) (currently 1.4.9).

---

## What Trove Is

Trove is a fork of VS Code OSS with AI capabilities integrated into the workbench rather than bolted on as an extension. The AI stack lives under `src/vs/workbench/contrib/trove/` and follows VS Code’s strict process boundaries (browser renderer, Electron main, shared common types).

### Core capabilities

| Area | What it does |
|------|----------------|
| **Agent chat** (`Ctrl+L`) | Multi-turn agent loop: LLM → tool calls → results → repeat until done |
| **Quick edit** (`Ctrl+K`) | Inline edit selection with a focused LLM prompt |
| **Autocomplete** | Fill-in-the-middle completions with optional codebase context |
| **Built-in tools** | Read/search/edit files, run terminal commands, persistent dev-server terminals, **web search** |
| **Checkpoints** | Snapshot every user message and agent edit; rewind diffs per file |
| **Repo intelligence** | SQLite-backed workspace profile (languages, frameworks, commands, LLM summaries) |
| **Codebase search** | FTS5 semantic-ish search via `search_codebase` tool |
| **Web search** | `search_web` tool (Tavily) for live documentation and external context |
| **Agent delivery** | Detects build success, running dev servers, and localhost URLs; opens preview in workspace browser |
| **Structured plans** | Pre-run checklist the agent updates as tools complete |
| **Token economy** | Prompt caching, per-run system context, stale tool compaction, smarter wire trimming |
| **Natural memory** | “Remember that …” in chat saves to `trove-memory.md` without a full agent turn |
| **MCP** | Model Context Protocol tools discovered and passed to the agent alongside builtins |
| **Multi-provider** | Anthropic, OpenAI, Gemini, Ollama, vLLM, LM Studio, LiteLLM, DeepSeek, OpenRouter, Groq, Mistral, xAI, and OpenAI-compatible endpoints |

### Chat modes

- **Agent** — full tool access including edits, terminal, and web search
- **Gather** — read/search tools only (no edits or terminal)
- **Normal** — chat without tools

### Project customization

- **`.troverules`** — per-workspace AI instructions injected into the system prompt
- **`trove-memory.md`** — persistent user memory in the Trove data folder (via “Remember this” or natural-language remember requests)
- **Trove Settings** — per-feature model selection, API keys, global AI instructions, prompt cache, and web search

### UI highlights

- **Glass morphism** chat surfaces (input panel, tool cards, assistant output, delivery panel)
- **Live activity** — idle/streaming status while the agent plans, reads, and calls the model
- **Delivery output panel** — preview URL and **Approve / Reject** actions for pending workspace edits
- **Collapsible code snippets** for search and read tool results

---

## Prerequisites

| Requirement | Version / notes |
|-------------|----------------|
| **Node.js** | **v20.18.1+** (`.nvmrc` pins 20.18.2). Use `nvm use` if you use nvm. |
| **npm** | Required. **Yarn is not supported** (install will fail). |
| **Python** | 3.x — used by native module builds |
| **C++ toolchain** | Required for native deps (`@vscode/sqlite3`, etc.) |
| **macOS** | Xcode Command Line Tools |
| **Windows** | Visual Studio 2022/2019/2017 Build Tools with C++ workload |
| **Linux** | `build-essential`, `pkg-config`, `libsecret-1-dev`, etc. ([VS Code wiki](https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites)) |
| **RAM / disk** | ~8 GB+ RAM recommended for compile; several GB free disk |

---

## Build & development

### 1. Clone and install

```bash
git clone https://github.com/hari8g/trove_v1.git
cd trove_v1
nvm use          # optional, if using nvm
npm install
```

First `npm install` downloads Electron, compiles native modules, and installs extension dependencies. It can take 10–30+ minutes depending on machine and network.

### 2. Compile (one-shot)

```bash
npm run compile
npm run buildreact   # compile Trove React UI (sidebar, settings, onboarding)
```

### 3. Development workflow (recommended)

Run these in **separate terminals** and leave them running:

```bash
# Terminal 1 — TypeScript watch (VS Code core + Trove)
npm run watch

# Terminal 2 — Trove React UI watch (sidebar, settings, etc.)
npm run watchreact

# Terminal 3 — launch the dev build
./scripts/code.sh .
```

On **Windows**:

```bat
npm run watch
npm run watchreact
scripts\code.bat .
```

`./scripts/code.sh` runs `build/lib/preLaunch.js` (downloads Electron if needed, compiles if stale) and launches `.build/electron/Trove.app` (macOS) or `.build/electron/trove` (Linux).

### 4. Launch options

```bash
./scripts/code.sh .                    # open this repo as workspace
./scripts/code.sh /path/to/project     # open another folder
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh .   # skip preLaunch (faster restart)
```

### 5. Production / packaged build

Packaging follows the upstream VS Code gulp tasks. On the **host platform/arch** you are building for:

```bash
# Full compile + package (unminified)
npm run gulp vscode

# Minified release build
npm run gulp vscode-min
```

Platform-specific examples:

```bash
npm run gulp vscode-darwin-arm64       # macOS Apple Silicon
npm run gulp vscode-darwin-x64         # macOS Intel
npm run gulp vscode-linux-x64          # Linux x64
npm run gulp vscode-win32-x64          # Windows x64
```

Output lands under `../VSCode-<platform>-<arch>/` relative to the repo root (sibling directory). CI uses `*-ci` variants after a separate compile step.

### 6. Other useful scripts

| Script | Purpose |
|--------|---------|
| `npm run watchd` | Watch in background via `deemon` |
| `npm run compile-web` | Web build (no Electron) |
| `./scripts/code-web.sh` | Run web version |
| `npm run test-node` | Node unit tests |
| `npm run test-browser` | Browser unit tests (Playwright) |
| `npm run eslint` | Lint |
| `npm run hygiene` | Repo hygiene checks |

Trove-specific unit tests live alongside Trove code, e.g.:

- `src/vs/workbench/contrib/trove/browser/test/agentPlan.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/contextWindowTrim.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/parallelReadToolBatch.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/chatMemoryIntent.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/wireMessageTrim.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/toolResultCompaction.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/promptCache.test.ts`
- `src/vs/workbench/contrib/trove/browser/test/llmMessageUsage.test.ts`
- `src/vs/workbench/contrib/trove/electron-main/repoIntelligence/test/`

---

## Data paths

| Path | Contents |
|------|----------|
| `~/.trove-editor/` | Trove product data (`dataFolderName` in `product.json`) |
| `~/Library/Application Support/code-oss-dev/` | Dev build user data (macOS) |
| `~/.config/code-oss-dev/` | Dev build user data (Linux) |
| `%APPDATA%\code-oss-dev\` | Dev build user data (Windows) |
| `<userData>/trove-memory.md` | Persistent user memory file |

Repo intelligence SQLite DB and workspace profiles are managed in the Electron main process (see [ARCHITECTURE.md](ARCHITECTURE.md)).

---

## Configuration

1. Open **Trove Settings** from the sidebar gear or command palette.
2. Add API keys and pick models per feature (Chat, Autocomplete, Apply, SCM).
3. For local models, configure **Ollama**, **vLLM**, or **LM Studio** endpoints.
4. Add a **`.troverules`** file at the workspace root for project-specific instructions.
5. Under **Feature Options → Agent & token economy**:
   - **Prompt cache** — enables Anthropic `cache_control` breakpoints (OpenRouter, Bedrock, LiteLLM, Azure routes)
   - **Web search** — enables the `search_web` tool; add a [Tavily](https://tavily.com) API key

You can also save facts in chat with natural language, e.g. *“Remember that this API runs on port 3000.”*

---

## Repository layout (high level)

```
trove_v1/
├── product.json              # Product name, data folder, bundle IDs
├── ARCHITECTURE.md           # Detailed system design
├── TROVE_TOKEN_ARCHITECTURE_IMPLEMENTATION_GUIDE_v2.md  # Token economics deep dive
├── src/vs/                   # VS Code + Trove source
│   └── workbench/contrib/trove/   # ← all Trove-specific code
├── extensions/               # Built-in VS Code extensions
├── build/                    # Gulp build pipeline
└── scripts/                  # Launch scripts (code.sh, code.bat)
```

---

## Architecture

For process boundaries, the agent loop, token economy, IPC channels, services, tools, and extension points, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

For the token-cost problem and implementation rationale, see **[TROVE_TOKEN_ARCHITECTURE_IMPLEMENTATION_GUIDE_v2.md](TROVE_TOKEN_ARCHITECTURE_IMPLEMENTATION_GUIDE_v2.md)**.

---

## License

Trove builds on VS Code OSS (MIT) with Trove-specific contributions under Apache 2.0 (see file headers in `src/vs/workbench/contrib/trove/`). VS Code upstream remains MIT-licensed.

---

## Contributing

1. Follow the dev workflow above; keep `npm run watch` and `npm run watchreact` running while editing.
2. Trove UI changes: edit under `src/vs/workbench/contrib/trove/browser/react/src/` — see [react README](src/vs/workbench/contrib/trove/browser/react/README.md) (`.js` suffix on imports, shallow `src/` layout). After UI edits, run `npm run buildreact` or `npm run watchreact` so `out/vs/workbench/contrib/trove/browser/react/out/` stays in sync.
3. New agent tools: define in `common/prompt/prompts.ts`, implement in `browser/toolsService.ts`.
4. Read [ARCHITECTURE.md](ARCHITECTURE.md) before crossing browser/main process boundaries.
