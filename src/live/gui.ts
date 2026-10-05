/**
 * GUI 窗口解析(纯函数):把探测脚本吐出的原始窗口行收敛成 LiveApp[]。
 *
 * 单独成模块的原因:windows.ts 已接近行数上限,而这两个解析器与
 * "怎么探测"(PowerShell P/Invoke / wmctrl 进程调用)无关,放这里便于单测。
 */

import type { LiveApp, Tool } from "../model.ts";

interface RawGuiWindow {
	hwnd: string;
	pid: number;
	process: string;
	title: string;
}

/** 一个 GUI 窗口行(wmctrl 解析产物;hwnd 是十六进制字符串) */
export interface GuiWindow {
	hwnd: string;
	pid: number;
	title: string;
}

/** "pid → 进程名"的查询:默认实现读 /proc(linux.ts),测试注入假实现 */
export type ProcessNameLookup = (pid: number) => Promise<string | undefined> | string | undefined;

/** ais 关心的 GUI 应用:进程名(小写)→ 工具。powershell 给的是 ProcessName + ".exe" */
const GUI_PROCESSES: Record<string, Tool> = { "zed.exe": "zed", "deepseek harness.exe": "dsh" };

/**
 * 宽松判定进程名(Linux 的 /proc/<pid>/comm 形态不一:`zed`、`DeepSeek Harness`、
 * `deepseek-harness`)。分隔符统一成空格、去掉 .exe 后比较 —— 标题不参与判定,
 * 因为 Zed 的窗口标题可能就是工作目录名(实测本机是 `23652`)。
 */
export function toolFromProcessName(name: string): Tool | undefined {
	const norm = name.toLowerCase().replace(/\.exe$/, "").replace(/[-_\s]+/g, " ").trim();
	if (norm === "zed" || norm.startsWith("zed ")) return "zed";
	if (norm.startsWith("deepseek harness")) return "dsh";
	return undefined;
}

/** 按 pid 去重:同一进程的多个顶层窗口只留第一条(否则聚焦时可能抓到错窗口) */
export function dedupeAppsByPid(apps: LiveApp[]): LiveApp[] {
	const seen = new Set<number>();
	const out: LiveApp[] = [];
	for (const app of apps) {
		if (app.pid > 0) {
			if (seen.has(app.pid)) continue;
			seen.add(app.pid);
		}
		out.push(app);
	}
	return out;
}

/** 用注入的进程名查询把 wmctrl 窗口行收敛成 LiveApp[](标题只用于展示) */
export async function matchGuiWindows(windows: GuiWindow[], lookup: ProcessNameLookup): Promise<LiveApp[]> {
	const apps: LiveApp[] = [];
	for (const win of windows) {
		if (!win.title) continue;
		const tool = toolFromProcessName((await lookup(win.pid)) ?? "");
		if (tool) apps.push({ tool, pid: win.pid, hwnd: win.hwnd, title: win.title });
	}
	return dedupeAppsByPid(apps);
}

/**
 * 从 windows.ps1 的 guiWindows 列表里挑出 zed/dsh 的窗口(过滤空标题,按 pid 去重)。
 * 大小写不敏感:"DeepSeek Harness.exe" 中间有空格,且进程名大小写不保证。
 */
export function parseGuiWindows(json: unknown): LiveApp[] {
	const list = Array.isArray(json) ? json : [];
	const apps: LiveApp[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const row = raw as Partial<Record<keyof RawGuiWindow, unknown>>;
		const process = typeof row.process === "string" ? row.process.toLowerCase() : "";
		const tool = GUI_PROCESSES[process];
		const title = typeof row.title === "string" ? row.title : "";
		if (!tool || title.length === 0) continue;
		apps.push({
			tool,
			pid: typeof row.pid === "number" ? row.pid : 0,
			hwnd: typeof row.hwnd === "string" ? row.hwnd : undefined,
			title,
		});
	}
	return dedupeAppsByPid(apps);
}
