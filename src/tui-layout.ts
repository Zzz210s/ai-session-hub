/**
 * TUI 主体区渲染:列表行 + 右侧内容(会话详情 或 分屏面板)
 * 从 tui-view.ts 拆出以保持单文件 <200 行。
 */

import type { SessionView } from "./model.ts";
import { formatAge, shortCwd, title } from "./format.ts";
import { clampLine, displayWidth, fit, padVisible, sanitizeForDisplay } from "./text.ts";
import type { TuiState } from "./tui-view.ts";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const REVERSE = "\u001b[7m";
const FG_GREEN = "\u001b[38;5;114m";
const FG_YELLOW = "\u001b[38;5;179m";
const FG_RED = "\u001b[38;5;203m";

/**
 * 面板合成(与 tui-panes 的 composePanes 同语义的本地实现)
 * 核心不做硬依赖:即使未安装 tui-panes,渲染层也能把面板帧排好。
 */
interface PaneFrame {
	title: string;
	lines: string[];
	focused: boolean;
}

function composePanes(frames: PaneFrame[], width: number, height: number): string[] {
	if (frames.length === 0) return Array.from({ length: height }, () => " ".repeat(width));
	const perPane = Math.floor(height / frames.length);
	const out: string[] = [];
	for (const [index, frame] of frames.entries()) {
		const isLast = index === frames.length - 1;
		const rows = isLast ? height - perPane * index : perPane;
		const label = `${frame.focused ? "*" : " "} ${frame.title}`;
		const fitted = label.length > width ? `${label.slice(0, Math.max(0, width - 1))}~` : label;
		out.push(`${REVERSE}${fitted.padEnd(width)}${RESET}`);
		for (let row = 1; row < rows; row++) out.push(frame.lines[row - 1] ?? "");
	}
	while (out.length < height) out.push("");
	return out.slice(0, height);
}

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
	const tool = view.tool.padEnd(8);
	const name = sanitizeForDisplay(title(view));
	const meta =
		view.state === "running"
			? `${shortCwd(view.cwd)} - ${formatAge(view.updatedAt, state.now)}${view.live?.tab ? ` - t${view.live.tab.index + 1}` : ""}`
			: `${shortCwd(view.cwd)} - ${formatAge(view.updatedAt, state.now)}`;
	const text = `${glyph} ${tool}${name}`;
	const metaWidth = Math.max(0, leftWidth - displayWidth(text) - 3);
	const body = `${fit(sanitizeForDisplay(text), leftWidth - 1 - Math.min(metaWidth, 22))}${fit(meta, Math.min(metaWidth, 22))}`;
	if (selected) {
		// 选中行整行反显;行内不能插 RESET,否则反显被打断(表现为"看不到光标")
		return `${REVERSE} ${body}${RESET}`;
	}
	return ` ${body.replace(glyph, `${statusColor(view)}${glyph}${RESET}${DIM}`)}${RESET}`;
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
	const badges = [view.tool, view.state === "running" ? `> ${view.status ?? "运行中"}` : "历史", view.attention ? "需关注" : ""].filter(Boolean).join(" | ");
	lines.push(` ${DIM}${fit(badges, rightWidth - 2)}${RESET}`, "");
	for (const [label, value] of fields) {
		lines.push(` ${DIM}${fit(label, 10)}${RESET}${fit(sanitizeForDisplay(value), Math.max(4, rightWidth - 12))}`);
	}
	if (!state.panes?.length) {
		lines.push("", ` ${DIM}Enter 在分屏中打开该会话 | a 接管整个终端${RESET}`);
	}
	return lines;
}

/** 右侧内容:分屏面板优先,否则显示选中会话详情 */
function rightLines(state: TuiState, rightWidth: number, bodyHeight: number): string[] {
	if (state.panes?.length) {
		const frames: PaneFrame[] = state.panes.map((pane) => ({
			title: pane.title,
			focused: pane.focused,
			lines: pane.lines.map((line) => padVisible(line, rightWidth)),
		}));
		return composePanes(frames, rightWidth, bodyHeight);
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
