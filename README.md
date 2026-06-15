# Trove

Trove is an AI-native code editor forked from VS Code. Use AI agents on your codebase, checkpoint and visualize changes, and bring any model or host locally.

## Development

```bash
npm run watch          # compile TypeScript (keep running)
./scripts/code.sh .    # launch dev build
```

User data for dev builds: `~/Library/Application Support/code-oss-dev/` (macOS)

Product data folder: `~/.trove-editor/`

## Architecture

Trove-specific code lives under `src/vs/workbench/contrib/trove/`.

- `common/` — shared types, prompts, settings
- `browser/` — renderer services, React UI, IPC proxies
- `electron-main/` — SQLite, file I/O, LLM calls
