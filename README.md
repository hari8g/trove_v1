# Trove

Trove is an AI-native code editor built on [VS Code](https://github.com/microsoft/vscode). It adds a full agentic coding layer on top of the editor: multi-provider LLM chat, built-in tools (read, search, edit, terminal), inline diffs with checkpoints, codebase-aware autocomplete, and workspace intelligence — while keeping VS Code’s extension ecosystem and editing experience.

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
| **Built-in tools** | Read/search/edit files, run terminal commands, persistent dev-server terminals |
| **Checkpoints** | Snapshot every user message and agent edit; rewind diffs per file |
| **Repo intelligence** | SQLite-backed workspace profile (languages, frameworks, commands, LLM summaries) |
| **Codebase search** | FTS5 semantic-ish search via `search_codebase` tool |
| **Agent delivery** | Detects build success, running dev servers, and localhost URLs; opens preview |
| **Structured plans** | Pre-run checklist the agent updates as tools complete |
| **MCP** | Model Context Protocol tools discovered and passed to the agent alongside builtins |
| **Multi-provider** | Anthropic, OpenAI, Gemini, Ollama, vLLM, LM Studio, LiteLLM, DeepSeek, OpenRouter, Groq, Mistral, xAI, and OpenAI-compatible endpoints |

### Chat modes

- **Agent** — full tool access including edits and terminal
- **Gather** — read/search tools only (no edits or terminal)
- **Normal** — chat without tools

### Project customization

- **`.troverules`** — per-workspace AI instructions injected into the system prompt
- **`trove-memory.md`** — persistent user memory in the Trove data folder (via “Remember this”)
- **Trove Settings** — per-feature model selection, API keys, global AI instructions

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

---

## Repository layout (high level)

```
trove_v1/
├── product.json              # Product name, data folder, bundle IDs
├── src/vs/                   # VS Code + Trove source
│   └── workbench/contrib/trove/   # ← all Trove-specific code
├── extensions/               # Built-in VS Code extensions
├── build/                    # Gulp build pipeline
├── scripts/                  # Launch scripts (code.sh, code.bat)
└── ARCHITECTURE.md           # Detailed system design
```

---

## Architecture

For process boundaries, the agent loop, IPC channels, services, tools, and extension points, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## License

Trove builds on VS Code OSS (MIT) with Trove-specific contributions under Apache 2.0 (see file headers in `src/vs/workbench/contrib/trove/`). VS Code upstream remains MIT-licensed.

---

## Contributing

1. Follow the dev workflow above; keep `npm run watch` and `npm run watchreact` running while editing.
2. Trove UI changes: edit under `src/vs/workbench/contrib/trove/browser/react/src/` — see [react README](src/vs/workbench/contrib/trove/browser/react/README.md) (`.js` suffix on imports, shallow `src/` layout).
3. New agent tools: define in `common/prompt/prompts.ts`, implement in `browser/toolsService.ts`.
4. Read [ARCHITECTURE.md](ARCHITECTURE.md) before crossing browser/main process boundaries.
