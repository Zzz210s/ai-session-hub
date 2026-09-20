/**
 * TUI 主体区渲染:列表行 + 右侧内容(会话详情 或 分屏面板)
 * 从 tui-view.ts 拆出以保持单文件 <200 行。
 */

import type { SessionView } from "./model.ts";
import { formatAge, title } from "./format.ts";
import { clampLine, displayWidth, fit, padVisible, sanitizeForDisplay } from "./text.ts";
import { namedNameColor, toolColor } from "./theme.ts";
import type { TuiState } from "./tui-view.ts";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const REVERSE = "\u001b[7m";
const FG_GREEN = "\u001b[38;5;114m";
const FG_YELLOW = "\u001b[38;5;179m";
const FG_RED = "\u001b[38;5;203m";

function statusGlyph(view: SessionView): string {
	if (view.attention) return "!";
	if (view.state !== "running") return " ";
	// 全 ASCII:宽度不确定字符(◐ ▸ · × 等)在部分终端按双宽渲染会导致整列错位
	const map: Record<string, string> = { working: "*", tool: ">", waiting: "|", stalled: "?", error: "x", idle: "." };
	return map[view.status ?? "running"] ?? ">";
}

function statusColor(view: SessionView): string {
	if (view.attention) return FG_YELLOW;
	if (view.state !== "running") return DIM;
	if (view.status === "error") return FG_RED;
	if (view.status === "waiting" || view.status === "stalled") return FG_YELLOW;
	return FG_GREEN;
}

export function rowLine(view: SessionView, selected: boolean, leftWidth: number, state: TuiState): string {
	const glyph = statusGlyph(view);
	const tool = view.tool.padEnd(9); // 最长工具名(opencode)后留一个空格
	const name = sanitizeForDisplay(title(view));
	// 总览里只放"工具 + 会话名";目录/年龄/标签等一律放到右侧详情
	const body = fit(`${glyph} ${tool}${name}`, leftWidth - 1);
	if (selected) {
		// 选中行整行反显;行内不能插 RESET,否则反显被打断(表现为"看不到光标")
		return `${REVERSE} ${body}${RESET}`;
	}
	// 工具名按各家 CLI 的品牌色着色(pi 青绿 / claude 橙 / opencode 暖橙 …)
	const colorOn = state.color !== false;
	const toolTint = toolColor(view.tool, colorOn);
	let tinted = toolTint ? body.replace(tool.trimEnd(), `${toolTint}${tool.trimEnd()}${RESET}${DIM}`) : body;
	// 被用户命名过的会话名用亮黄色突出
	const nameTint = view.named ? namedNameColor(colorOn) : "";
	if (nameTint) tinted = tinted.replace(name, `${nameTint}${name}${RESET}${DIM}`);
	return ` ${tinted.replace(glyph, `${statusColor(view)}${glyph}${RESET}${DIM}`)}${RESET}`;
}

export function detailLines(view: SessionView | undefined, rightWidth: number, state: TuiState): string[] {
	if (!view) return [`${DIM}  从左侧选择一个会话${RESET}`];
	const fields: [string, string][] = [
		["工作目录", view.cwd || "-"],
		["更新时间", formatAge(view.updatedAt, state.now)],
		["创建时间", view.createdAt.toLocaleString()],
		["会话体积", view.sizeBytes ? `${(view.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "-"],
		["进程", view.live?.pid ?? view.live?.heartbeat?.pid ? `pid ${view.live?.pid ?? view.live?.heartbeat?.pid}` : "-"],
		["终端标签", view.live?.tab ? `窗口 ${view.live.tab.windowPid} - 第 ${view.live.tab.index + 1} 个` : "-"],
		["会话文件", view.file],
	];
	const lines = [` ${BOLD}${fit(sanitizeForDisplay(title(view)), rightWidth - 2)}${RESET}`];
	const badgeParts = [view.tool, view.state === "running" ? `> ${view.status ?? "运行中"}` : "历史", view.attention ? "需关注" : ""].filter(Boolean);
	const tint = toolColor(view.tool, state.color !== false);
	const badges = badgeParts.join(" | ");
	// 第一个徽标是工具名:单独着色,其余保持暗淡
	const tintedBadges = tint ? badges.replace(view.tool, `${tint}${view.tool}${RESET}${DIM}`) : badges;
	lines.push(` ${DIM}${fit(tintedBadges, rightWidth - 2)}${RESET}`, "");
	for (const [label, value] of fields) {
		lines.push(` ${DIM}${fit(label, 10)}${RESET}${fit(sanitizeForDisplay(value), Math.max(4, rightWidth - 12))}`);
	}
	return lines;
}

/** 右侧内容:分屏面板优先,否则显示选中会话详情 */
function rightLines(state: TuiState, rightWidth: number, bodyHeight: number): string[] {
	// 拓展接管时用它的内容(逐行按可见宽度补齐/截断),否则显示核心的详情视图
	if (state.customBody?.length) {
		const lines = state.customBody.map((line) => clampLine(padVisible(line, rightWidth), rightWidth));
		while (lines.length < bodyHeight) lines.push("");
		return lines.slice(0, bodyHeight);
	}
	return detailLines(state.rows[state.cursor], rightWidth, state);
}

/** 渲染主体区(列表 + 右侧) */
export function renderBody(state: TuiState, leftWidth: number, rightWidth: number, bodyHeight: number): string[] {
	const total = state.rows.length;
	let start = Math.max(0, Math.min(state.cursor - Math.floor(bodyHeight / 2), total - bodyHeight));
	if (start < 0) start = 0;
	const lines: string[] = [];
	for (let index = 0; index < bodyHeight; index++) {
		const rowIndex = start + index;
		const view = state.rows[rowIndex];
		const left = view ? rowLine(view, rowIndex === state.cursor, leftWidth, state) : " ".repeat(leftWidth);
		const right = rightLines(state, rightWidth, bodyHeight)[index] ?? "";
		lines.push(`${padVisible(left, leftWidth)} ${clampLine(padVisible(right, rightWidth), rightWidth)}`);
	}
	return lines;
}
