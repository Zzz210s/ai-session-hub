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

/** ais 关心的 GUI 应用:进程名(小写)→ 工具。powershell 给的是 ProcessName + ".exe" */
const GUI_PROCESSES: Record<string, Tool> = { "zed.exe": "zed", "deepseek harness.exe": "dsh" };

/**
 * 从 windows.ps1 的 guiWindows 列表里挑出 zed/dsh 的窗口。
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
	return apps;
}
