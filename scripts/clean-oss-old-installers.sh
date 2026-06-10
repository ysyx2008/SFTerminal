#!/usr/bin/env bash
# 从 OSS releases/ 删除旧版完整安装包，永久保留全部 .blockmap。
# 策略说明见 docs/auto-update-oss.md
# 用法: OSSUTIL=/path/to/ossutil64 BUCKET=oss://sfterm-download ./scripts/clean-oss-old-installers.sh 10.43.2
set -euo pipefail

VERSION="${1:?Usage: clean-oss-old-installers.sh <version>}"
OSSUTIL="${OSSUTIL:?OSSUTIL is required}"
BUCKET="${BUCKET:-oss://sfterm-download}"
RELEASES="${BUCKET}/releases/"

echo "🧹 Cleaning old full installers in ${RELEASES} (keep blockmaps + v${VERSION})..."

removed=0
while IFS= read -r uri; do
  [[ -z "$uri" ]] && continue
  base=$(basename "$uri")

  # 永久保留 blockmap，不参与清理
  if [[ "$base" == *.blockmap ]]; then
    continue
  fi

  should_remove=false

  if [[ "$base" =~ ^SailFish-Setup-.+\.exe$ ]] && [[ "$base" != "SailFish-Setup-${VERSION}.exe" ]]; then
    should_remove=true
  elif [[ "$base" =~ ^SailFish-.+-x64\.zip$ ]] && [[ "$base" != "SailFish-${VERSION}-x64.zip" ]]; then
    should_remove=true
  elif [[ "$base" =~ ^SailFish-.+\.dmg$ ]] \
    && [[ "$base" != "SailFish-${VERSION}.dmg" ]] \
    && [[ "$base" != "SailFish-${VERSION}-arm64.dmg" ]]; then
    should_remove=true
  elif [[ "$base" =~ ^SailFish-.+\.zip$ ]] && [[ "$base" != *"${VERSION}"* ]]; then
    should_remove=true
  elif [[ "$base" =~ ^SailFish-.+\.AppImage$ ]] && [[ "$base" != "SailFish-${VERSION}.AppImage" ]]; then
    should_remove=true
  fi

  if [[ "$should_remove" == true ]]; then
    echo "  rm ${uri}"
    $OSSUTIL rm "$uri" -f
    removed=$((removed + 1))
  fi
done < <($OSSUTIL ls "$RELEASES" -s 2>/dev/null || true)

echo "✅ Removed ${removed} old installer(s); all blockmaps kept permanently"
