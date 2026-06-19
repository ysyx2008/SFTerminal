#!/usr/bin/env bash
# 打包 Firefox AMO 发布 zip（不修改 ../firefox/ 开发目录）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_SRC="$ROOT/resources/browser-bridge/firefox"
SHARED_SRC="$ROOT/resources/browser-bridge/shared"
AMO_OVERLAY="$ROOT/resources/browser-bridge/firefox-amo-publish"
BUILD="$ROOT/resources/browser-bridge/.firefox-amo-build"
DIST="$ROOT/resources/browser-bridge/dist"
VERSION="$(node -pe "require('$AMO_OVERLAY/manifest.json').version")"
OUT="$DIST/sailfish-browser-assistant-firefox-${VERSION}.zip"

for dir in "$DEV_SRC" "$SHARED_SRC" "$AMO_OVERLAY"; do
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

# 2) AMO 专用 manifest + 图标覆盖
cp "$AMO_OVERLAY/manifest.json" "$BUILD/manifest.json"
rm -rf "$BUILD/icons"
cp -R "$AMO_OVERLAY/icons" "$BUILD/icons"

rm -f "$OUT"
(
  cd "$BUILD"
  zip -r "$OUT" . -x '*.DS_Store'
)
rm -rf "$BUILD"

echo "Packed (AMO): $OUT"
echo "Dev source unchanged: $DEV_SRC"
echo "AMO overlay: $AMO_OVERLAY"
echo "Size: $(du -h "$OUT" | cut -f1)"
echo ""
echo "Upload: https://addons.mozilla.org/developers/addon/submit/0"
echo "Guide: docs/browser-bridge-firefox-amo.md"
