/**
 * 展示格式化(纯函数):列表行、状态标记、相对时间
 */

import type { SessionView } from "./model.ts";

const TOOL_LABEL: Record<string, string> = {
	pi: "pi",
	claude: "claude",
	opencode: "opencode",
	codex: "codex",
	gemini: "gemini",
	zed: "zed",
};

// ASCII 字形:避免 Unicode 宽度不确定字符在部分终端按双宽渲染造成错位
const STATUS_ICON: Record<string, string> = {
	working: "*",
	tool: ">",
	waiting: "|",
	stalled: "?",
	error: "x",
	idle: ".",
	running: ">",
};

export function formatAge(date: Date, now: Date = new Date()): string {
	const minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes}分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}小时前`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}天前`;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shortCwd(cwd: string): string {
	if (!cwd) return "-";
	const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || cwd;
}

export function stateMark(view: SessionView): string {
	if (view.state !== "running") return " ";
	if (view.attention) return "!";
	return "*";
}

export function statusIcon(view: SessionView): string {
	if (view.state !== "running") return " ";
	return STATUS_ICON[view.status ?? "running"] ?? "▸";
}

export function title(view: SessionView): string {
	const raw = view.name?.trim() || view.topic?.trim() || view.id.slice(0, 8);
	return raw.length > 34 ? `${raw.slice(0, 33)}...` : raw;
}

/** 单行展示:[!*] pi   auth-refactor  |  work/api  |  3分钟前  |  running tab 3 */
export function formatRow(view: SessionView, now: Date = new Date()): string {
	const mark = `${stateMark(view)}${statusIcon(view)}`.padEnd(2);
	const tool = (TOOL_LABEL[view.tool] ?? view.tool).padEnd(8);
	const name = title(view);
	const cwd = shortCwd(view.cwd);
	const age = formatAge(view.updatedAt, now);
	const live = view.state === "running" ? describeLive(view) : "历史";
	return `[${mark}] ${tool} ${name}  |  ${cwd}  |  ${age}  |  ${live}`;
}

export function describeLive(view: SessionView): string {
	const parts: string[] = [];
	parts.push(view.status ?? "running");
	if (view.live?.tab) parts.push(`tab ${view.live.tab.index}`);
	else if (view.live?.pid) parts.push(`pid ${view.live.pid}`);
	if (view.live?.heartbeat) parts.push("heartbeat");
	return parts.join(" ");
}

export interface SummaryCounts {
	total: number;
	running: number;
	attention: number;
	byTool: Record<string, number>;
}

export function summarize(views: SessionView[]): SummaryCounts {
	const byTool: Record<string, number> = {};
	let running = 0;
	let attention = 0;
	for (const view of views) {
		byTool[view.tool] = (byTool[view.tool] ?? 0) + 1;
		if (view.state === "running") running++;
		if (view.attention) attention++;
	}
	return { total: views.length, running, attention, byTool };
}
