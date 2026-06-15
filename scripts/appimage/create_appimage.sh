#!/bin/bash

# Exit on error
set -e

# Check platform
platform=$(uname)

if [[ "$platform" == "Darwin" ]]; then
    echo "Running on macOS. Note that the AppImage created will only work on Linux systems."
    if ! command -v docker &> /dev/null; then
        echo "Docker Desktop for Mac is not installed. Please install it from https://www.docker.com/products/docker-desktop"
        exit 1
    fi
elif [[ "$platform" == "Linux" ]]; then
    echo "Running on Linux. Proceeding with AppImage creation..."
else
    echo "This script is intended to run on macOS or Linux. Current platform: $platform"
    exit 1
fi

# Enable BuildKit
export DOCKER_BUILDKIT=1

BUILD_IMAGE_NAME="void-appimage-builder"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Please start Docker first."
    exit 1
fi

# Check and install Buildx if needed
if ! docker buildx version >/dev/null 2>&1; then
    echo "Installing Docker Buildx..."
    mkdir -p ~/.docker/cli-plugins/
    curl -SL https://github.com/docker/buildx/releases/download/v0.13.1/buildx-v0.13.1.linux-amd64 -o ~/.docker/cli-plugins/docker-buildx
    chmod +x ~/.docker/cli-plugins/docker-buildx
fi

# Download appimagetool if not present
if [ ! -f "appimagetool" ]; then
    echo "Downloading appimagetool..."
    wget -O appimagetool "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool
fi

# Delete any existing AppImage to avoid bloating the build
rm -f Void-x86_64.AppImage

# Create build Dockerfile
echo "Creating build Dockerfile..."
cat > Dockerfile.build << 'EOF'
# syntax=docker/dockerfile:1
FROM ubuntu:20.04

# Install required dependencies
RUN apt-get update && apt-get install -y \
    libfuse2 \
    libglib2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxss1 \
    libxtst6 \
    libnss3 \
    libasound2 \
    libdrm2 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
EOF

# Create .dockerignore file
echo "Creating .dockerignore file..."
cat > .dockerignore << EOF
Dockerfile.build
.dockerignore
.git
.gitignore
.DS_Store
*~
*.swp
*.swo
*.tmp
*.bak
*.log
*.err
node_modules/
venv/
*.egg-info/
*.tox/
dist/
EOF

# Build Docker image without cache
echo "Building Docker image (no cache)..."
docker build --no-cache -t "$BUILD_IMAGE_NAME" -f Dockerfile.build .

# Create AppImage using local appimagetool
echo "Creating AppImage..."
docker run --rm --privileged -v "$(pwd):/app" "$BUILD_IMAGE_NAME" bash -c '
cd /app && \
rm -rf TroveApp.AppDir && \
mkdir -p TroveApp.AppDir/usr/bin TroveApp.AppDir/usr/lib TroveApp.AppDir/usr/share/applications && \
find . -maxdepth 1 ! -name TroveApp.AppDir ! -name "." ! -name ".." -exec cp -r {} TroveApp.AppDir/usr/bin/ \; && \
cp void.png TroveApp.AppDir/ && \
echo "[Desktop Entry]" > TroveApp.AppDir/trove.desktop && \
echo "Name=Void" >> TroveApp.AppDir/trove.desktop && \
echo "Comment=Open source AI code editor." >> TroveApp.AppDir/trove.desktop && \
echo "GenericName=Text Editor" >> TroveApp.AppDir/trove.desktop && \
echo "Exec=trove %F" >> TroveApp.AppDir/trove.desktop && \
echo "Icon=void" >> TroveApp.AppDir/trove.desktop && \
echo "Type=Application" >> TroveApp.AppDir/trove.desktop && \
echo "StartupNotify=false" >> TroveApp.AppDir/trove.desktop && \
echo "StartupWMClass=Trove" >> TroveApp.AppDir/trove.desktop && \
echo "Categories=TextEditor;Development;IDE;" >> TroveApp.AppDir/trove.desktop && \
echo "MimeType=application/x-void-workspace;" >> TroveApp.AppDir/trove.desktop && \
echo "Keywords=void;" >> TroveApp.AppDir/trove.desktop && \
echo "Actions=new-empty-window;" >> TroveApp.AppDir/trove.desktop && \
echo "[Desktop Action new-empty-window]" >> TroveApp.AppDir/trove.desktop && \
echo "Name=New Empty Window" >> TroveApp.AppDir/trove.desktop && \
echo "Name[de]=Neues leeres Fenster" >> TroveApp.AppDir/trove.desktop && \
echo "Name[es]=Nueva ventana vacía" >> TroveApp.AppDir/trove.desktop && \
echo "Name[fr]=Nouvelle fenêtre vide" >> TroveApp.AppDir/trove.desktop && \
echo "Name[it]=Nuova finestra vuota" >> TroveApp.AppDir/trove.desktop && \
echo "Name[ja]=新しい空のウィンドウ" >> TroveApp.AppDir/trove.desktop && \
echo "Name[ko]=새 빈 창" >> TroveApp.AppDir/trove.desktop && \
echo "Name[ru]=Новое пустое окно" >> TroveApp.AppDir/trove.desktop && \
echo "Name[zh_CN]=新建空窗口" >> TroveApp.AppDir/trove.desktop && \
echo "Name[zh_TW]=開新空視窗" >> TroveApp.AppDir/trove.desktop && \
echo "Exec=trove --new-window %F" >> TroveApp.AppDir/trove.desktop && \
echo "Icon=void" >> TroveApp.AppDir/trove.desktop && \
chmod +x TroveApp.AppDir/trove.desktop && \
cp TroveApp.AppDir/trove.desktop TroveApp.AppDir/usr/share/applications/ && \
echo "[Desktop Entry]" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Name=Trove - URL Handler" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Comment=Open source AI code editor." > TroveApp.AppDir/trove-url-handler.desktop && \
echo "GenericName=Text Editor" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Exec=trove --open-url %U" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Icon=void" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Type=Application" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "NoDisplay=true" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "StartupNotify=true" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Categories=Utility;TextEditor;Development;IDE;" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "MimeType=x-scheme-handler/void;" > TroveApp.AppDir/trove-url-handler.desktop && \
echo "Keywords=void;" > TroveApp.AppDir/trove-url-handler.desktop && \
chmod +x TroveApp.AppDir/trove-url-handler.desktop && \
cp TroveApp.AppDir/trove-url-handler.desktop TroveApp.AppDir/usr/share/applications/ && \
echo "#!/bin/bash" > TroveApp.AppDir/AppRun && \
echo "HERE=\$(dirname \"\$(readlink -f \"\${0}\")\")" >> TroveApp.AppDir/AppRun && \
echo "export PATH=\${HERE}/usr/bin:\${PATH}" >> TroveApp.AppDir/AppRun && \
echo "export LD_LIBRARY_PATH=\${HERE}/usr/lib:\${LD_LIBRARY_PATH}" >> TroveApp.AppDir/AppRun && \
echo "exec \${HERE}/usr/bin/void --no-sandbox \"\$@\"" >> TroveApp.AppDir/AppRun && \
chmod +x TroveApp.AppDir/AppRun && \
chmod -R 755 TroveApp.AppDir && \

# Strip unneeded symbols from the binary to reduce size
strip --strip-unneeded TroveApp.AppDir/usr/bin/void

ls -la TroveApp.AppDir/ && \
ARCH=x86_64 ./appimagetool -n TroveApp.AppDir Void-x86_64.AppImage
'

# Clean up
rm -rf TroveApp.AppDir .dockerignore appimagetool

echo "AppImage creation complete! Your AppImage is: Void-x86_64.AppImage"
