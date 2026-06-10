#!/usr/bin/env bash
# 一次性：从 GitHub Releases 回填历史 *.blockmap 到 OSS releases/（供国内差分更新）。
# 前置：gh 已登录；ossutil 已 config（或设置 OSSUTIL 指向可执行文件）。
# 用法: ./scripts/sync-blockmaps-github-to-oss.sh [--limit N]
set -euo pipefail

REPO="${REPO:-ysyx2008/SailFish}"
BUCKET="${BUCKET:-oss://sfterm-download}"
OSSUTIL="${OSSUTIL:-ossutil64}"
LIMIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:?}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--limit N]   # N=0 表示全部 release（默认）"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

command -v gh >/dev/null || { echo "需要 gh CLI" >&2; exit 1; }
command -v "$OSSUTIL" >/dev/null || { echo "需要 ossutil（或设置 OSSUTIL）" >&2; exit 1; }

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "📦 回填 blockmap: GitHub ${REPO} → ${BUCKET}/releases/"
echo "   工作目录: ${WORKDIR}"

mapfile -t TAGS < <(gh release list --repo "$REPO" --limit 500 --json tagName -q '.[].tagName')
if [[ ${#TAGS[@]} -eq 0 ]]; then
  echo "未找到任何 release" >&2
  exit 1
fi

if [[ "$LIMIT" -gt 0 ]]; then
  TAGS=("${TAGS[@]:0:$LIMIT}")
fi

total=0
skipped=0

for tag in "${TAGS[@]}"; do
  rm -rf "${WORKDIR:?}"/*
  if ! gh release download "$tag" --repo "$REPO" -p '*.blockmap' -D "$WORKDIR" 2>/dev/null; then
    echo "⏭  ${tag}: 无 blockmap，跳过"
    skipped=$((skipped + 1))
    continue
  fi

  count=$(find "$WORKDIR" -maxdepth 1 -name '*.blockmap' | wc -l | tr -d ' ')
  if [[ "$count" -eq 0 ]]; then
    echo "⏭  ${tag}: 无 blockmap，跳过"
    skipped=$((skipped + 1))
    continue
  fi

  echo "⬆  ${tag}: ${count} 个 blockmap"
  for f in "$WORKDIR"/*.blockmap; do
    "$OSSUTIL" cp "$f" "${BUCKET}/releases/$(basename "$f")" -f
    total=$((total + 1))
  done
done

echo "✅ 完成：上传 ${total} 个 blockmap，跳过 ${skipped} 个 release"
