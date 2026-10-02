#!/usr/bin/env bash
#
# 打包发布产物(Windows / Linux 通用,Git Bash 与 Linux 都能跑)
#
#   scripts/package.sh <version> <windows|linux>
#
# 产物:
#   dist/ai-session-hub-<version>-windows.zip      (解压后是 ai-session-hub-<version>/)
#   dist/ai-session-hub-<version>-linux.tar.gz     (同上)
# 内容:仓库文件,排除 .git / node_modules / .codegraph / dist

set -euo pipefail

VERSION="${1:-}"
TARGET="${2:-}"
if [ -z "$VERSION" ] || [ -z "$TARGET" ]; then
  echo "用法: scripts/package.sh <version> <windows|linux>" >&2
  exit 2
fi
case "$TARGET" in windows|linux) ;; *) echo "目标只能是 windows 或 linux" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
STAGE="ai-session-hub-$VERSION"
DIST="$ROOT/dist"

rm -rf "$DIST/$STAGE"
mkdir -p "$DIST/$STAGE"

# 用 tar 复制:两边都有 tar,且排除规则一致(rsync 在 Windows runner 上不保证有)
tar -cf - \
  --exclude=.git --exclude=node_modules --exclude=.codegraph --exclude=dist \
  . | tar -xf - -C "$DIST/$STAGE"

# 去掉不该发布的本地残留(缓存/临时)
rm -rf "$DIST/$STAGE/.ai-session-hub" 2>/dev/null || true
chmod +x "$DIST/$STAGE/install.sh" "$DIST/$STAGE/bin/ais" 2>/dev/null || true

if [ "$TARGET" = "windows" ]; then
  ARCHIVE="$DIST/$STAGE-windows.zip"
  rm -f "$ARCHIVE"
  if command -v zip >/dev/null 2>&1; then
    (cd "$DIST" && zip -qr "$(basename "$ARCHIVE")" "$STAGE")
  else
    # Git Bash / Windows runner 上不一定有 zip:用系统自带的 Compress-Archive
    PS="$(command -v pwsh || command -v powershell || true)"
    if [ -z "$PS" ]; then
      echo "缺少 zip,也没有 PowerShell 的 Compress-Archive" >&2
      exit 1
    fi
    if command -v cygpath >/dev/null 2>&1; then
      STAGE_WIN="$(cygpath -w "$DIST/$STAGE")"
      ARCHIVE_WIN="$(cygpath -w "$ARCHIVE")"
    else
      STAGE_WIN="$DIST/$STAGE"
      ARCHIVE_WIN="$ARCHIVE"
    fi
    "$PS" -NoProfile -NonInteractive -Command "Compress-Archive -Path '$STAGE_WIN' -DestinationPath '$ARCHIVE_WIN' -Force" >/dev/null
  fi
else
  ARCHIVE="$DIST/$STAGE-linux.tar.gz"
  rm -f "$ARCHIVE"
  tar -czf "$ARCHIVE" -C "$DIST" "$STAGE"
fi

rm -rf "$DIST/$STAGE"
echo "$ARCHIVE"
