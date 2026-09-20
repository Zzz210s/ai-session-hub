/**
 * Windows 侧活体探测:调用 PowerShell 枚举 AI CLI 进程 + Windows Terminal 标签
 * (UI Automation;标签标题即各 CLI 写出的状态,如 pi-tab-status 的 "◐ 会话名")
 */

import { execFile } from "node:child_process";
import { cacheDir, readCache, ttlFromEnv, writeCache } from "../cache.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConsoleWindow, LiveProcess, TerminalTab, Tool } from "../model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "scripts", "windows.ps1");

export interface LiveSnapshot {
	processes: LiveProcess[];
	tabs: TerminalTab[];
	/** 非 Windows Terminal 的控制台窗口(conhost / PowerShell 控制台) */
	consoleWindows: ConsoleWindow[];
	error?: string;
}

/** 依据命令行判定属于哪个 CLI;不属于任何已知 CLI 时返回 null */
export function classifyProcess(cmd: string): { tool: Tool; internal: boolean } | null {
	const lower = cmd.toLowerCase();
	if (lower.includes("pi-coding-agent")) {
		// 子代理以 --mode json 运行,不算独立会话
		const internal = /--mode\s+json/.test(lower);
		return { tool: "pi", internal };
	}
	if (lower.includes("@anthropic-ai") || lower.includes("claude-code")) {
		return { tool: "claude", internal: false };
	}
	if (/[\\/]opencode|opencode-ai/.test(lower)) {
		return { tool: "opencode", internal: false };
	}
	return null;
}

function runPowerShell(scriptPath: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
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

/** 活体探测的 TTL 缓存(默认 8 秒):TUI 每 3 秒刷新,没有缓存会反复起 PowerShell */
export async function probeLive(options: { noCache?: boolean; ttlMs?: number } = {}): Promise<LiveSnapshot> {
	const ttlMs = options.ttlMs ?? ttlFromEnv("AIS_LIVE_TTL_MS", 8000);
	const cacheOptions = { path: join(cacheDir(), "live.json"), ttlMs };
	if (!options.noCache) {
		const cached = await readCache<LiveSnapshot>(cacheOptions);
		if (cached) return cached;
	}
	const fresh = await probeLiveUncached();
	if (!options.noCache) void writeCache(cacheOptions, fresh);
	return fresh;
}

async function probeLiveUncached(): Promise<LiveSnapshot> {
	let raw: { processes?: RawProcess[]; tabs?: RawTab[]; consoleWindows?: RawConsoleWindow[] };
	try {
		const stdout = await runPowerShell(SCRIPT, []);
		raw = JSON.parse(stdout.trim() || "{}") as typeof raw;
	} catch (error) {
		return { processes: [], tabs: [], consoleWindows: [], error: error instanceof Error ? error.message : String(error) };
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
			args: (item.cmd ?? "").slice(0, 200),
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

	return { processes, tabs, consoleWindows };
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
