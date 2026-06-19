#!/usr/bin/env bash
# 打包 Chrome Web Store 发布 zip（不修改 ../chromium/ 开发目录）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_SRC="$ROOT/resources/browser-bridge/chromium"
SHARED_SRC="$ROOT/resources/browser-bridge/shared"
CWS_OVERLAY="$ROOT/resources/browser-bridge/chromium-cws-publish"
ICON_SRC="$ROOT/resources/browser-bridge/firefox-amo-publish/icons"
BUILD="$ROOT/resources/browser-bridge/.chrome-cws-build"
DIST="$ROOT/resources/browser-bridge/dist"
VERSION="$(node -pe "require('$CWS_OVERLAY/manifest.json').version")"
OUT="$DIST/sailfish-browser-assistant-chrome-${VERSION}.zip"

for dir in "$DEV_SRC" "$SHARED_SRC" "$CWS_OVERLAY" "$ICON_SRC"; do
  if [[ ! -d "$dir" ]]; then
    echo "Missing $dir" >&2
    exit 1
  fi
done

rm -rf "$BUILD"
mkdir -p "$BUILD" "$DIST"

# 1) 开发版逻辑（临时加载测试用同一套 JS）
cp -R "$DEV_SRC"/* "$BUILD/"
mkdir -p "$BUILD/shared"
cp -R "$SHARED_SRC"/* "$BUILD/shared/"

# 2) CWS 专用 manifest + 图标覆盖
cp "$CWS_OVERLAY/manifest.json" "$BUILD/manifest.json"
rm -rf "$BUILD/icons"
cp -R "$ICON_SRC" "$BUILD/icons"

rm -f "$OUT"
(
  cd "$BUILD"
  zip -r "$OUT" . -x '*.DS_Store'
)
rm -rf "$BUILD"

echo "Packed (CWS): $OUT"
echo "Dev source unchanged: $DEV_SRC"
echo "CWS overlay: $CWS_OVERLAY"
echo "Size: $(du -h "$OUT" | cut -f1)"
echo ""
echo "Upload: https://chrome.google.com/webstore/devconsole"
echo "Privacy: https://www.sfterm.com/browser-assistant-privacy/"
