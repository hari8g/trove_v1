#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/src/vs/workbench/browser/parts/editor/media/trove-logo-dark.png"
ICONSET_BASE="$(mktemp -d /tmp/trove-icon.XXXXXX)"
ICONSET="${ICONSET_BASE}.iconset"
mv "$ICONSET_BASE" "$ICONSET"
PNG_SOURCE="$(mktemp /tmp/trove-logo-source.XXXXXX.png)"

cleanup() {
	rm -rf "$ICONSET" "$PNG_SOURCE"
}
trap cleanup EXIT

if [[ ! -f "$SOURCE" ]]; then
	echo "Logo source not found: $SOURCE" >&2
	exit 1
fi

magick "$SOURCE" "$PNG_SOURCE"

for spec in \
	"16:icon_16x16.png" \
	"32:icon_16x16@2x.png" \
	"32:icon_32x32.png" \
	"64:icon_32x32@2x.png" \
	"128:icon_128x128.png" \
	"256:icon_128x128@2x.png" \
	"256:icon_256x256.png" \
	"512:icon_256x256@2x.png" \
	"512:icon_512x512.png" \
	"1024:icon_512x512@2x.png"
do
	size="${spec%%:*}"
	name="${spec##*:}"
	magick "$PNG_SOURCE" -resize "${size}x${size}" "$ICONSET/$name"
done

iconutil -c icns "$ICONSET" -o "$ROOT/resources/darwin/code.icns"
magick "$PNG_SOURCE" -background none -gravity center -extent 1200x1200 "$ROOT/resources/linux/code.png"
magick "$PNG_SOURCE" -define icon:auto-resize=256,128,64,48,32,16 "$ROOT/resources/win32/code.ico"
magick "$PNG_SOURCE" -resize 150x150 "$ROOT/resources/win32/code_150x150.png"
magick "$PNG_SOURCE" -resize 70x70 "$ROOT/resources/win32/code_70x70.png"
cp "$PNG_SOURCE" "$ROOT/resources/win32/logo_cube_noshadow.png"

ELECTRON_ICNS="$ROOT/.build/electron/Trove.app/Contents/Resources/Trove.icns"
if [[ -f "$ELECTRON_ICNS" ]]; then
	cp "$ROOT/resources/darwin/code.icns" "$ELECTRON_ICNS"
	touch "$ROOT/.build/electron/Trove.app/Contents/Info.plist"
fi

echo "Generated Trove app icons in resources/{darwin,linux,win32}/"
