# Trove AppImage Creation Script

This is a community-made AppImage creation script. There are some reported bugs with it.

To generate an AppImage yourself, feel free to look at `stable-linux.yml` in the separate `void-builder/` repo, which runs a GitHub Action that builds the AppImage you see on our website.

This script automates the process of creating an AppImage for the Trove Editor using Docker. It works on macOS and Linux platforms.

## Requirements

* **Docker:** The script relies on Docker to build the AppImage inside a container.
* **macOS or Linux:** The script is designed for these platforms. On macOS, it generates a Linux-compatible AppImage.
* **Internet Connection:** Required for downloading necessary tools (like `docker-buildx` and `appimagetool` inside the Docker container).

## Prerequisites

1. **Install Docker:**

   * **macOS:** Download and install Docker Desktop from [docker.com](https://docker.com).
   * **Ubuntu:**
     ```bash
     sudo apt install docker.io
     ```
   * **Arch Linux:**
     ```bash
     sudo pacman -S docker
     ```
   * **Fedora:**
     ```bash
     sudo dnf install docker
     ```

2. **Set Docker User Group:**

   Docker requires users to be part of the `docker` group to run Docker commands without `sudo`.

   ```bash
   sudo usermod -aG docker $USER
   ```

   After running this command, log out and log back in for the group changes to take effect.

3. **Enable and Start Docker:**

   ```bash
   sudo systemctl enable docker
   sudo systemctl start docker
   ```

## Ubuntu Dependencies (Installed via Docker)

These dependencies are installed within the Docker container (Ubuntu 20.04 base). You generally don't need to install them manually:

* `libfuse2`
* `libglib2.0-0`
* `libgtk-3-0`
* `libx11-xcb1`
* `libxss1`
* `libxtst6`
* `libnss3`
* `libasound2`
* `libdrm2`
* `libgbm1`

## Usage Instructions

1. **Build Trove first** (from the repo root):

   ```bash
   npm install
   npm run compile
   ```

   The AppImage bundles the compiled `void` binary and resources from your build output.

2. **Copy Required Files:**

   Copy the following files to the directory where the app binary is being bundled (created during the build process):

   * `create_appimage.sh`
   * `trove.desktop`
   * `void.png`

3. **Make the Script Executable:**

   ```bash
   chmod +x create_appimage.sh
   ```

4. **Run the Script:**

   ```bash
   ./create_appimage.sh
   ```

5. **Result:**

   After the script completes, it generates an AppImage named `Void-x86_64.AppImage` (legacy filename; the binary inside is Trove) in the current directory.

## Script Overview

* **Platform Check:** Checks for macOS or Linux. Exits if unsupported.
* **Docker Checks:** Ensures Docker is installed and running.
* **Buildx Installation:** Installs `docker buildx` if missing.
* **`appimagetool` Download:** Downloads `appimagetool` inside the Docker container.
* **Dockerfile Creation:** Creates a temporary `Dockerfile.build` for the Ubuntu-based environment.
* **Docker Image Build:** Builds a Docker image and runs the build process.
* **AppImage Creation:**
  * Creates the `TroveApp.AppDir` structure.
  * Copies binaries, resources, and the `.desktop` entry.
  * Copies `trove.desktop` and `void.png`.
  * Strips unnecessary symbols from the binary.
  * Runs `appimagetool` to generate the AppImage.
* **Cleanup:** Removes the temporary `Dockerfile.build`.

## Trove Runtime Data (AppImage installs)

The AppImage is portable, but Trove stores per-user state outside the bundle:

| Path | Purpose |
|------|---------|
| `~/.config/Trove/` (or `$XDG_CONFIG_HOME/Trove/`) | Settings, encrypted API keys, chat threads |
| `<userData>/User/globalStorage/trove-repo-intelligence.db` | SQLite workspace index (code chunks + symbols) |
| `<userData>/trove-memory.md` | Persistent agent memory from “remember that …” messages |

On first workspace open, Trove builds a **repo intelligence index** in the SQLite DB:

* **Code chunks** — powers `search_codebase` (BM25 FTS5)
* **Symbols** — powers `get_file_outline`, `get_symbol`, and `search_symbols` (incremental, hash-gated re-index on file changes)

**Token economy** (Trove Settings → Agent & token economy):

* **Prompt caching** — stable system prompt (rules, tools, repo profile) is cached separately from volatile workspace state (open files, directory tree). Expect high cache-read ratios on multi-turn agent sessions when enabled.
* **OpenAI routing** — chat threads use a consistent `prompt_cache_key` for prefix cache affinity.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the full agent loop, tool list, and caching design.

## Troubleshooting

* **Docker Not Running:** Ensure Docker is installed and running.
* **Permission Issues:** Try running the script with `sudo` or check Docker permissions.
* **Outdated Dependencies:** Ensure you have the minimum required versions.
* **Symbol tools return empty:** Open a workspace and wait for indexing to finish (status bar shows chunk count). Unsupported languages are skipped.

## License

This script is provided "as is". It is free to use, modify, and distribute, but comes with no warranty.
