/**
 * Windows 侧活体探测:调用 PowerShell 枚举 AI CLI 进程 + Windows Terminal 标签
 * (UI Automation;标签标题即各 CLI 写出的状态,如 pi-tab-status 的 "◐ 会话名")
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cacheDir, readCache, ttlFromEnv, writeCache } from "../cache.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleWindow, LiveApp, LiveProcess, TerminalTab } from "../model.ts";
import { resolvePowerShellEngine } from "../powershell.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "windows.ps1");

export interface LiveSnapshot {
	processes: LiveProcess[];
	tabs: TerminalTab[];
	/** 非 Windows Terminal 的控制台窗口(conhost / PowerShell 控制台) */
	consoleWindows: ConsoleWindow[];
	/** 正在运行的 GUI 应用实例(zed / dsh);只有窗口、不承载单条会话 */
	apps?: LiveApp[];
	error?: string;
	/** 这份快照来自过期缓存(已在后台刷新) —— 界面可先拿它渲染 */
	stale?: boolean;
}

// 引擎解析在 powershell.ts(唯一写者);这里再导出,原有导入路径不变
export { findPwsh, resolvePowerShellEngine } from "../powershell.ts";

// 进程判定在 classify.ts、GUI 窗口解析在 gui.ts,两者都从这里再导出
import { classifyProcess } from "./classify.ts";
import { parseGuiWindows } from "./gui.ts";
export { classifyProcess, parseGuiWindows };

let engine: string | null = null;

function engineOf(): string {
	if (!engine) engine = resolvePowerShellEngine();
	return engine;
}

/** 测试/切换引擎用:下次调用重新解析 */
export function resetPowerShellEngine(): void {
	engine = null;
}

/**
 * 跑一次脚本;若用的是 pwsh 而它失败了(坏安装/权限),永久回退到 powershell.exe —— 不让每次探测都白试一遍。
 * 注意 windows.ps1 的调用方自己吞掉错误,所以这里的重试是有意义的。
 */
async function runPowerShell(scriptPath: string, args: string[]): Promise<string> {
	const exe = engineOf();
	try {
		return await runWith(exe, scriptPath, args);
	} catch (error) {
		if (exe === "powershell.exe") throw error;
		engine = "powershell.exe";
		return runWith("powershell.exe", scriptPath, args);
	}
}

function runWith(exe: string, scriptPath: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			exe,
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
			{ maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (error && !stdout) {
					reject(new Error(`${error.message} ${stderr ?? ""}`.trim()));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

interface RawProcess {
	pid: number;
	name: string;
	startedAt: string;
	cmd: string;
}

interface RawConsoleWindow {
	hwnd: string;
	pid: number;
	title: string;
}

interface RawTab {
	hwnd: string;
	windowPid: number;
	windowTitle: string;
	index: number;
	title: string;
	selected: boolean;
}

interface RawGuiWindow {
	hwnd: string;
	pid: number;
	process: string;
	title: string;
}

export async function probeLiveUncached(): Promise<LiveSnapshot> {
	let raw: { processes?: RawProcess[]; tabs?: RawTab[]; consoleWindows?: RawConsoleWindow[]; guiWindows?: RawGuiWindow[] };
	try {
		const stdout = await runPowerShell(SCRIPT, []);
		raw = JSON.parse(stdout.trim() || "{}") as typeof raw;
	} catch (error) {
		return { processes: [], tabs: [], consoleWindows: [], apps: [], error: error instanceof Error ? error.message : String(error) };
	}

	const processes: LiveProcess[] = [];
	for (const item of raw.processes ?? []) {
		const kind = classifyProcess(item.cmd ?? "");
		if (!kind) continue;
		const started = new Date(item.startedAt || Date.now());
		processes.push({
			pid: item.pid,
			tool: kind.tool,
			startedAt: Number.isNaN(started.getTime()) ? new Date() : started,
			args: (item.cmd ?? "").slice(0, 400),
			internal: kind.internal,
		});
	}

	const tabs: TerminalTab[] = (raw.tabs ?? []).map((tab) => ({
		hwnd: String(tab.hwnd ?? ""),
		windowPid: tab.windowPid,
		windowTitle: tab.windowTitle ?? "",
		index: tab.index,
		title: tab.title ?? "",
		selected: Boolean(tab.selected),
	}));

	const consoleWindows: ConsoleWindow[] = (raw.consoleWindows ?? [])
		.filter((entry) => entry && entry.hwnd && entry.pid)
		.map((entry) => ({ hwnd: String(entry.hwnd), pid: Number(entry.pid), title: entry.title ?? "" }));

	const apps = parseGuiWindows(raw.guiWindows);

	return { processes, tabs, consoleWindows, apps };
}

/** 直接聚焦某个窗口句柄(控制台窗口场景) */
export async function focusWindow(hwnd: string): Promise<{ ok: boolean; detail: string }> {
	const script = join(here, "..", "..", "scripts", "focus.ps1");
	try {
		const stdout = await runPowerShell(script, ["-Hwnd", hwnd]);
		return { ok: stdout.trim() === "FOCUSED", detail: stdout.trim() };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** 聚焦指定标签(优先按窗口句柄精确定位,回退到进程号) */
export async function focusTab(tab: Pick<TerminalTab, "hwnd" | "windowPid" | "index">): Promise<{ ok: boolean; detail: string }> {
	const script = join(here, "..", "..", "scripts", "focus.ps1");
	const args = ["-WindowPid", String(tab.windowPid), "-TabIndex", String(tab.index)];
	if (tab.hwnd) args.push("-Hwnd", tab.hwnd);
	try {
		const stdout = await runPowerShell(script, args);
		const detail = stdout.trim();
		return { ok: detail === "FOCUSED", detail };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
