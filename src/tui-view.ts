/**
 * TUI 纯渲染层:状态 → 屏幕行(含 ANSI),可单测、无副作用
 * 主体区(列表/详情/分屏)在 tui-layout.ts,文本工具在 text.ts。
 */

import type { SessionView } from "./model.ts";
import { clampLine, displayWidth, fit, stripAnsi, sanitizeForDisplay } from "./text.ts";
import { renderBody } from "./tui-layout.ts";

export { clampLine, displayWidth, fit, padVisible, sanitizeForDisplay, stripAnsi } from "./text.ts";

export type FilterKind = "running" | "attention" | "all" | "stored";

/** 拓展接管主体区时提供的行(已由拓展自行组合好) */
export type CustomBody = string[];

export interface TuiState {
	rows: SessionView[];
	totals: { all: number; running: number; attention: number; stored: number };
	filter: FilterKind;
	query: string;
	searchMode: boolean;
	cursor: number;
	width: number;
	height: number;
	message?: string;
	refreshedAt: Date;
	now: Date;
	/** 待确认的破坏性操作提示(如删除会话);非空时底部显示并等待 y/n */
	confirm?: string;
	/** 是否着色(由入口按 NO_COLOR / TTY 判定) */
	color?: boolean;
	/** 拓展接管的主体区内容(为空则显示核心的详情视图) */
	customBody?: CustomBody;
	/** 拓展声明的底部提示片段 */
	customHints?: string[];
}

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const REVERSE = "\u001b[7m";
const FG_GREEN = "\u001b[38;5;114m";
const FG_YELLOW = "\u001b[38;5;179m";

/** 按筛选与搜索过滤会话(纯函数) */
export function filterRows(rows: SessionView[], filter: FilterKind, query: string): SessionView[] {
	const byFilter = rows.filter((row) =>
		filter === "all" ? true : filter === "attention" ? row.attention : filter === "running" ? row.state === "running" : row.state !== "running",
	);
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return byFilter;
	return byFilter.filter((row) => {
		const haystack = `${row.name ?? ""} ${row.topic} ${row.cwd} ${row.tool} ${row.id}`.toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
}

/** 总量统计(纯函数) */
export function totalsOf(rows: SessionView[]): TuiState["totals"] {
	return {
		all: rows.length,
		running: rows.filter((row) => row.state === "running").length,
		attention: rows.filter((row) => row.attention).length,
		stored: rows.filter((row) => row.state !== "running").length,
	};
}

/** 视口计算:保证 cursor 可见 */
export function viewport(state: TuiState): { start: number; end: number; bodyHeight: number } {
	const bodyHeight = Math.max(3, state.height - 3);
	const total = state.rows.length;
	let start = Math.max(0, Math.min(state.cursor - Math.floor(bodyHeight / 2), total - bodyHeight));
	if (start < 0) start = 0;
	return { start, end: Math.min(total, start + bodyHeight), bodyHeight };
}

function headerLine(state: TuiState): string {
	const stats = [
		`共 ${state.totals.all}`,
		`${FG_GREEN}运行中 ${state.totals.running}${RESET}`,
		state.totals.attention > 0 ? `${FG_YELLOW}需关注 ${state.totals.attention}${RESET}` : "需关注 0",
	];
	const plain = stats.join(" | ");
	const gap = Math.max(1, state.width - displayWidth("AI 会话总览") - displayWidth(plain) - 3);
	return ` ${BOLD}AI 会话总览${RESET}${" ".repeat(gap)}${DIM}${plain}${RESET} `;
}

function filterBar(state: TuiState): string {
	const tabs: { key: FilterKind; label: string }[] = [
		{ key: "running", label: `1 运行中 ${state.totals.running}` },
		{ key: "attention", label: `2 需关注 ${state.totals.attention}` },
		{ key: "all", label: `3 全部 ${state.totals.all}` },
		{ key: "stored", label: `4 历史 ${state.totals.stored}` },
	];
	const rendered = tabs
		.map((tab) => (state.filter === tab.key ? `${REVERSE}${tab.label}${RESET}` : `${DIM}${tab.label}${RESET}`))
		.join("  ");
	const tabsWidth = tabs.map((tab) => displayWidth(tab.label)).reduce((sum, w) => sum + w, 0) + (tabs.length - 1) * 2;
	const search = state.searchMode ? `${BOLD}搜索: ${state.query}|${RESET}` : `${DIM}搜索: ${state.query || "(按 / 输入)"}${RESET}`;
	const extHint = state.customHints?.length ? `${FG_GREEN}${state.customHints.join(" · ")}${RESET}  ` : "";
	const pad = Math.max(1, state.width - tabsWidth - displayWidth(stripAnsi(search)) - displayWidth(stripAnsi(extHint)) - 4);
	return ` ${rendered}${" ".repeat(pad)}${extHint}${search} `;
}

/** 底部按键提示(分屏聚焦时不同) */
/**
 * 底部行:统一为「键位 | 消息」——键位在前(位置固定,便于肌肉记忆),
 * 消息在后。确认态把键位换成 y/n(此状态下只有这两个键有效)。
 * 说明:只列核心键位,Enter 的行为取决于会话状态与是否装了拓展,故不在此承诺;
 * 拓展自己的键位由拓展通过 hints 提供(见 filterBar),无拓展时不出现拓展字样。
 */
function footerText(state: TuiState): string {
	const keys = state.confirm ? "y 确认 / n 取消" : "a 接管终端 | f 聚焦窗口 | c 复制 | d 删除 | 1-4 筛选 | / 搜索 | q 退出";
	const message = state.confirm ?? state.message;
	return message ? `${keys} | ${sanitizeForDisplay(message)}` : keys;
}

/**
 * 布局尺寸:由 (终端宽高, 是否拓展接管主体区) 决定,不依赖 TuiState ——
 * 这样拓展询问"我能用多大空间"时不会反过来触发主体区渲染(否则会无限递归)。
 */
export function layoutMetricsFor(widthInput: number, heightInput: number, extensionMode: boolean): LayoutMetrics {
	const width = Math.max(40, widthInput - 1); // 末列留白,避免折行挂起
	const height = Math.max(10, heightInput);
	const leftWidth = extensionMode ? Math.min(38, Math.max(24, Math.floor(width * 0.28))) : Math.min(52, Math.max(30, Math.floor(width * 0.45)));
	return { width, height, leftWidth, rightWidth: Math.max(20, width - leftWidth - 2), bodyHeight: Math.max(3, height - 3) };
}

/** 由 TuiState 推导布局尺寸 */
export function layoutMetrics(state: TuiState): LayoutMetrics {
	return layoutMetricsFor(state.width, state.height, Boolean(state.customBody?.length));
}

/** 渲染整屏(返回行数组,调用方负责输出与刷新) */
export function renderScreen(state: TuiState): string[] {
	const { width, height, leftWidth, rightWidth, bodyHeight } = layoutMetrics(state);
	const paneMode = Boolean(state.panes?.length);

	const lines: string[] = [headerLine(state), filterBar(state), ...renderBody(state, leftWidth, rightWidth, bodyHeight)];
	if (state.rows.length === 0 && !paneMode) {
		lines[2] = ` ${DIM}没有匹配的会话(试试 3 全部 / 清空搜索)${RESET}`;
	}

	const footer = footerText(state);
	lines.push(` ${DIM}${fit(footer, Math.max(0, width - 2))}${RESET}`);
	return lines.slice(0, height).map((line) => clampLine(line, width));
}
