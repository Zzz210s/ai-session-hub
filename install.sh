#!/usr/bin/env bash
#
# ai-session-hub 一键安装(Linux)
#
# 用法(在解压出来的目录里):
#   ./install.sh                     # 交互式
#   ./install.sh --yes               # 不问任何问题
#   ./install.sh --yes --install-node  # 缺 Node 时用官方 tarball 装到 ~/.local/share/node
#   ./install.sh --uninstall         # 卸载(删程序目录 + 撤 PATH 条目)
#
# 做什么:
#   1. 检查 Node(需要 >= 24;可用 --install-node 从 nodejs.org 下官方 tarball)
#   2. 复制程序到 ${XDG_DATA_HOME:-~/.local/share}/ai-session-hub
#   3. 生成 ~/.local/bin/ais,必要时把 ~/.local/bin 写进 shell 启动文件(带标记,可 --no-modify-path 关掉)
#   4. 跑一次 ais doctor 自检(只读)
# 不做什么:不拉任何仓库、不跑别人的 setup.sh、不动别人的配置。
#
# 平台说明:实况探测用 ps(进程)与心跳注册表;窗口聚焦需要 wmctrl 或 xdotool。
#          macOS 的 BSD ps 不支持 -o etimes,本安装器会在 Darwin 上直接说明不支持。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DIR="${AIS_INSTALL_DIR:-$DATA_HOME/ai-session-hub}"
BIN_DIR="$HOME/.local/bin"
SHIM="$BIN_DIR/ais"
VERSION="unknown"
YES=0
INSTALL_NODE=0
UNINSTALL=0
MODIFY_PATH=1
NODE_DIR="$DATA_HOME/node"

step() { printf '\033[36m[ais]\033[0m %s\n' "$1"; }
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33m注意\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m失败\033[0m %s\n' "$1"; }

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --install-node) INSTALL_NODE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-modify-path) MODIFY_PATH=0 ;;
    --dir=*) DIR="${arg#--dir=}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) warn "未知参数:$arg" ;;
  esac
done

if [ -f "$SCRIPT_DIR/package.json" ]; then
  VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/package.json" | head -1)"
  [ -n "$VERSION" ] || VERSION="unknown"
fi

confirm() {
  [ "$YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

echo
echo "ai-session-hub $VERSION - AI 会话总览与跳转(Linux 安装器)"
echo "安装目录: $DIR"
echo

# ---------- 卸载 ----------
if [ "$UNINSTALL" = "1" ]; then
  step "卸载"
  if [ -d "$DIR" ]; then rm -rf "$DIR"; ok "已删除 $DIR"; else warn "目录不存在,跳过删除"; fi
  if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then rm -f "$SHIM"; ok "已删除 $SHIM"; fi
  echo
  echo "会话缓存(~/.ai-session-hub)与心跳注册表(~/.ai-sessions)已保留,如需清理请手动删除。"
  exit 0
fi

# ---------- 1. Node ----------
step "检查 Node.js(需要 >= 24)"
node_bin="$(command -v node || true)"
major=0
if [ -n "$node_bin" ]; then major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"; fi

install_node() {
  local arch base file
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "不支持的架构:$(uname -m)"; return 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || { fail "需要 curl 才能下载 Node"; return 1; }
  command -v tar >/dev/null 2>&1 || { fail "需要 tar 才能解压 Node"; return 1; }
  base="https://nodejs.org/dist/latest-v24.x"
  # 用 .tar.gz(不需要 xz,发行版最小安装里常见没有 xz)
  file="$(curl -fsSL "$base/" 2>/dev/null | grep -o "node-v24\.[0-9.]*-linux-$arch\.tar\.gz" | head -1)"
  if [ -z "$file" ]; then fail "没能从 nodejs.org 找到 v24 的 $arch 包(检查网络)"; return 1; fi
  step "下载 $file -> $NODE_DIR"
  mkdir -p "$NODE_DIR" || { fail "创建 $NODE_DIR 失败"; return 1; }
  if ! curl -fsSL "$base/$file" -o "/tmp/$file"; then fail "下载 $file 失败"; return 1; fi
  if ! tar -xzf "/tmp/$file" -C "$NODE_DIR" --strip-components=1; then fail "解压 $file 失败"; rm -f "/tmp/$file"; return 1; fi
  rm -f "/tmp/$file"
  if [ ! -x "$NODE_DIR/bin/node" ]; then fail "解压后没找到可执行的 $NODE_DIR/bin/node"; return 1; fi
  export PATH="$NODE_DIR/bin:$PATH"
  node_bin="$NODE_DIR/bin/node"
  major="$("$node_bin" -v | sed 's/^v\([0-9]*\).*/\1/')"
  ok "Node 已装到 $NODE_DIR/bin/node($("$node_bin" -v))"
}

if [ "$major" -lt 24 ] && [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  node_bin="$NODE_DIR/bin/node"
  major="$("$node_bin" -v | sed 's/^v\([0-9]*\).*/\1/')"
  ok "复用已装好的 Node $("$node_bin" -v)($NODE_DIR)"
fi

if [ "$major" -lt 24 ]; then
  warn "当前 Node: ${node_bin:-未安装}(${major:+v$major}),需要 24 或更高"
  if [ "$INSTALL_NODE" = "1" ] || confirm "从 nodejs.org 下载官方 Node 24 到 $NODE_DIR?"; then
    install_node || exit 1
  else
    fail "缺少 Node 24+。可用发行版包管理器安装,或加 --install-node 让本脚本装官方包"
    exit 1
  fi
fi
[ "$major" -ge 24 ] || { fail "Node 版本仍不满足"; exit 1; }
ok "Node $(node -v)($node_bin)"

# ---------- 2. 复制程序 ----------
step "复制程序文件 -> $DIR"
mkdir -p "$DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude .git --exclude node_modules --exclude .codegraph "$SCRIPT_DIR"/ "$DIR"/
else
  for entry in "$SCRIPT_DIR"/* "$SCRIPT_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in .git|node_modules|.codegraph) continue ;; esac
    rm -rf "$DIR/$(basename "$entry")"
    cp -R "$entry" "$DIR/"
  done
fi
ok "已复制(版本 $VERSION)"

# ---------- 3. 造 shim + PATH ----------
step "生成命令 ais"
mkdir -p "$BIN_DIR"
# 软链到安装目录里自带的 bin/ais(相对自身解析仓库根),这样以后覆盖安装目录不用重建命令
if [ -e "$SHIM" ] && [ ! -L "$SHIM" ]; then rm -f "$SHIM"; fi
ln -sfn "$DIR/bin/ais" "$SHIM"
chmod +x "$DIR/bin/ais" 2>/dev/null || true
ok "$SHIM -> $DIR/bin/ais"

MARKER="# >>> ai-session-hub >>>"
if [ "$MODIFY_PATH" = "1" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ok "$BIN_DIR 已在 PATH 中" ;;
    *)
      rc="$HOME/.profile"
      [ -n "${ZSH_VERSION:-}" ] && rc="$HOME/.zshrc"
      [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ] && rc="$HOME/.bashrc"
      if ! grep -q "$MARKER" "$rc" 2>/dev/null; then
        {
          echo ""
          echo "$MARKER"
          [ -x "$NODE_DIR/bin/node" ] && echo 'export PATH="'"$NODE_DIR/bin:$BIN_DIR"':$PATH"'
          [ -x "$NODE_DIR/bin/node" ] || echo 'export PATH="'"$BIN_DIR"':$PATH"'
          echo "# <<< ai-session-hub <<<"
        } >> "$rc"
        ok "已把 $BIN_DIR$( [ -x "$NODE_DIR/bin/node" ] && echo " 与 $NODE_DIR/bin" )写进 $rc(新终端生效)"
      else
        ok "$rc 里已有 PATH 条目"
      fi
      ;;
  esac
else
  warn "已按要求不修改 PATH;请自行确保 $BIN_DIR 在 PATH 中"
fi

# ---------- 4. 自检 ----------
step "自检: ais doctor"
if PATH="$NODE_DIR/bin:$BIN_DIR:$PATH" node --no-warnings "$DIR/src/cli.ts" doctor 2>&1 | head -14; then
  ok "自检完成"
else
  warn "自检未通过;可手动运行:$SHIM doctor"
fi

echo
printf '\033[32m装好了。\033[0m新开一个终端,输入 ais 打开看板。\n'
echo "  ais            看板(↑↓ 移动,Enter 打开,/ 搜索,q 退出)"
echo "  ais doctor     自检    ais list --live  只看运行中    ais gc --yes  清理心跳"
echo "  窗口聚焦需要 wmctrl 或 xdotool(装一个即可)"
echo "  卸载:$DIR/install.sh --uninstall"
if ! command -v ais >/dev/null 2>&1; then
  echo "  当前 shell 还找不到 ais:先执行 export PATH=\"$BIN_DIR:\$PATH\"(或新开终端)"
fi
