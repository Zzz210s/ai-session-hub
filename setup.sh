#!/usr/bin/env bash
# ai-session-hub 安装脚本(幂等)
#   1) 建心跳目录 ~/.ai-sessions/live
#   2) 安装 pi 心跳扩展 -> ~/.pi/agent/extensions/
#   3) 可选安装 Claude Code 心跳钩子(--install-claude-hook,合并进 ~/.claude/settings.json)
#   4) 若存在 ~/bin,生成 ais 命令
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVE_DIR="$HOME/.ai-sessions/live"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
HOOK_CMD="node $REPO_DIR/integrations/claude-heartbeat.mjs"

log() { printf '[ai-session-hub] %s\n' "$*"; }
warn() { printf '[ai-session-hub] 警告: %s\n' "$*" >&2; }

mkdir -p "$LIVE_DIR"
log "心跳目录就绪: $LIVE_DIR"

# --- 1. pi 心跳扩展 ---
if [ -d "$AGENT_DIR/extensions" ]; then
  cp -f "$REPO_DIR/integrations/pi-heartbeat.ts" "$AGENT_DIR/extensions/pi-heartbeat.ts"
  log "pi 心跳扩展已安装: $AGENT_DIR/extensions/pi-heartbeat.ts(重启 pi 或 /reload 后生效)"
else
  warn "未找到 $AGENT_DIR/extensions,跳过 pi 心跳扩展"
fi

# --- 2. Claude Code 心跳钩子 ---
install_claude_hook() {
  if [ ! -f "$CLAUDE_SETTINGS" ]; then
    warn "未找到 $CLAUDE_SETTINGS,跳过"
    return
  fi
  AI_SESSION_HUB_HOOK="$HOOK_CMD" node - "$CLAUDE_SETTINGS" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const cmd = process.env.AI_SESSION_HUB_HOOK;
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
settings.hooks = settings.hooks ?? {};
const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
let added = 0;
for (const event of events) {
	const list = (settings.hooks[event] = settings.hooks[event] ?? []);
	if (JSON.stringify(list).includes("ai-session-hub")) continue;
	const entry = { hooks: [{ type: "command", command: cmd }] };
	if (event === "PreToolUse" || event === "PostToolUse") entry.matcher = "*";
	list.push(entry);
	added += 1;
}
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
console.log(`[ai-session-hub] Claude 钩子已合并(${added} 个事件)`);
if (settings.disableAllHooks) {
	console.log("[ai-session-hub] 注意: 你的 settings.json 里 disableAllHooks=true,全部钩子被禁用;");
	console.log("[ai-session-hub]       要让 Claude 心跳生效需改成 false,否则 Claude 活性走兜底推断。");
}
NODE
}

if [ "${1:-}" = "--install-claude-hook" ]; then
  install_claude_hook
else
  log "Claude Code 心跳钩子(可选):bash setup.sh --install-claude-hook"
  log "  将执行的命令: $HOOK_CMD"
fi

# --- 3. ais 命令 ---
# 解析仓库真实路径(去掉 junction / symlink):即使以后删掉 ~ 下的便捷链接,
# 启动器仍指向真正的开发环境
REPO_REAL="$(cd "$REPO_DIR" && pwd -P)"
if [ -d "$HOME/bin" ]; then
  # 装"解析式"启动器:文件里不含本机绝对路径,仓库位置单独写进 ais.path。
  # 启动器按 [ais.path → ~/ai-session-hub → 自身上级目录] 依次解析,都找不到时打印指引 ——
  # 所以仓库所在盘没挂载、或仓库被搬走,都不会再抛 MODULE_NOT_FOUND。
  cp -f "$REPO_DIR/bin/ais"     "$HOME/bin/ais"
  cp -f "$REPO_DIR/bin/ais.cmd" "$HOME/bin/ais.cmd"
  cp -f "$REPO_DIR/bin/ais.ps1" "$HOME/bin/ais.ps1"   # 带 BOM,cp 逐字节保留
  chmod +x "$HOME/bin/ais"
  printf '%s\n' "$REPO_REAL" > "$HOME/bin/ais.path"
  log "已安装命令: $HOME/bin/ais(bash)· ais.cmd / ais.ps1(cmd/PowerShell);仓库位置记在 $HOME/bin/ais.path"
else
  log "用法: node $REPO_DIR/src/cli.ts [list|doctor|focus <查询>];TUI 直接运行 ais"
fi

log "完成。先跑 'node $REPO_DIR/src/cli.ts doctor' 看探测结果。"
