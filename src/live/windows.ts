/**
 * Windows 侧活体探测:调用 PowerShell 枚举 AI CLI 进程 + Windows Terminal 标签
 * (UI Automation;标签标题即各 CLI 写出的状态,如 pi-tab-status 的 "◐ 会话名")
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
	/** 这份快照来自过期缓存(已在后台刷新) —— 界面可先拿它渲染 */
	stale?: boolean;
}

/**
 * 选 PowerShell 引擎:优先 PowerShell 7(pwsh)。
 *
 * 本机实测(5 轮交替采样,scripts/windows.ps1):
 *   powershell.exe  最小 1254ms / 平均 1363ms
 *   pwsh 7          最小 1431ms / 平均 1714ms   ← **更慢**
 * 所以默认仍是系统自带的 powershell.exe;想用 pwsh 自己指定(AIS_PWSH=<路径>)。
 * 三份脚本(windows.ps1 / focus.ps1 / recycle.ps1)在 pwsh 下都已验证能跑,所以随时可切。
 */
export function resolvePowerShellEngine(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): string {
	const override = (env.AIS_PWSH ?? "").trim();
	if (!override || /^(auto|default|0|false|1|true)$/i.test(override)) return "powershell.exe";
	return override;
}

/** 探测 pwsh 的位置(仅用于提示/诊断;默认不启用) */
export function findPwsh(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): string | undefined {
	const candidates = [
		`${env.ProgramFiles ?? "C:/Program Files"}/PowerShell/7/pwsh.exe`,
		`${env.LOCALAPPDATA ?? ""}/Microsoft/WindowsApps/pwsh.exe`,
		`${env.USERPROFILE ?? ""}/scoop/shims/pwsh.exe`,
	];
	for (const candidate of candidates) if (fileExists(candidate)) return candidate;
	for (const dir of (env.PATH ?? "").split(";")) {
		if (!dir) continue;
		const candidate = `${dir.replace(/[\\/]$/, "")}/pwsh.exe`;
		if (fileExists(candidate)) return candidate;
	}
	return undefined;
}
// 进程判定是跳平台共用的,放在 classify.ts;这里导入供本模块使用,并原样再导出
import { classifyProcess } from "./classify.ts";

export { classifyProcess };

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

export async function probeLiveUncached(): Promise<LiveSnapshot> {
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
