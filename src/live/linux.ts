/**
 * Linux 实况探测(与 windows.ps1 同构,输出同一个 LiveSnapshot)。
 *
 * 与 Windows 的差别:
 *   - 进程来自 `ps -eo pid=,ppid=,etimes=,tty=,args=`(etimes 比 lstart 好解析,且不受语言影响)
 *   - 没有 Windows Terminal,没有 UI Automation:标签页这一层不存在(Linux 下会话的
 *     工作/等待状态来自心跳注册表 ~/.ai-sessions/live,那是跨平台的)
 *   - 聚焦窗口走 wmctrl / xdotool(有就用,没有就给明确提示)
 *
 * 纯解析部分(parsePsOutput)独立导出,便于在任意平台上单测。
 */

import { readFile } from "node:fs/promises";
import type { LiveApp, LiveProcess, LiveSnapshot } from "../model.ts";
import { classifyProcess } from "./classify.ts";
import { hasCommand, run } from "./exec.ts";
import { matchGuiWindows, type GuiWindow, type ProcessNameLookup } from "./gui.ts";

export interface PsRow {
	pid: number;
	ppid: number;
	/** 已运行秒数 */
	elapsedSeconds: number;
	/** 控制终端(如 pts/3),无终端为 "?" */
	tty: string;
	args: string;
}

/** 解析 `ps -eo pid=,ppid=,etimes=,tty=,args=`(依序取前 4 个字段,其余整段是命令行) */
export function parsePsOutput(text: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			elapsedSeconds: Number(match[3]),
			tty: match[4] ?? "?",
			args: match[5] ?? "",
		});
	}
	return rows;
}

/** ps 快照 → 会话进程(与 Windows 侧共用 classifyProcess 的判定) */
export function classifyPsRows(rows: PsRow[], now = Date.now()): LiveProcess[] {
	const processes: LiveProcess[] = [];
	for (const row of rows) {
		const kind = classifyProcess(row.args);
		if (!kind) continue;
		processes.push({
			pid: row.pid,
			tool: kind.tool,
			startedAt: new Date(now - row.elapsedSeconds * 1000),
			args: row.args.slice(0, 200),
			internal: kind.internal,
		});
	}
	return processes;
}


/**
 * 解析 `wmctrl -l -p` 输出(纯函数)。真实格式是五列:
 *   <hwnd> <桌面号> <pid> <client machine> <窗口标题>
 * 第 2 列是桌面号(sticky 窗口为 -1),pid 在第 3 列;标题里不含主机名。
 * 判定应用不靠标题(见 matchWmctrlApps),这里只负责切列,标题仅作展示。
 */
export function parseWmctrlOutput(text: string): GuiWindow[] {
	const windows: GuiWindow[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line.trim());
		if (!match) continue;
		windows.push({ hwnd: match[1] ?? "", pid: Number(match[3]), title: match[5] ?? "" });
	}
	return windows;
}

/** 默认查进程名:先读 /proc/<pid>/comm(最可靠),读不到再退回 ps(Non-Linux 或进程已退出) */
export async function lookupProcessName(pid: number): Promise<string | undefined> {
	if (!Number.isFinite(pid) || pid <= 0) return undefined;
	try {
		const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
		if (name) return name;
	} catch {
		// 没有 /proc(非 Linux)或进程已退出:退回 ps
	}
	const result = await run("ps", ["-p", String(pid), "-o", "comm="]);
	const name = result.out.trim();
	return result.ok && name ? name : undefined;
}

/** 窗口行 + 可注入的进程名查询 → LiveApp[](pid → 进程名,标题只用于展示) */
export function matchWmctrlApps(windows: GuiWindow[], lookup: ProcessNameLookup = lookupProcessName): Promise<LiveApp[]> {
	return matchGuiWindows(windows, lookup);
}

/** X11:用 wmctrl 列 GUI 窗口;Wayland 通常没有 wmctrl → 空数组(降级为"只列会话不聚焦") */
export async function listGuiWindowsLinux(): Promise<LiveApp[]> {
	if (!(await hasCommand("wmctrl"))) return [];
	const listed = await run("wmctrl", ["-l", "-p"]);
	if (!listed.ok) return [];
	return matchWmctrlApps(parseWmctrlOutput(listed.out));
}

export async function probeLiveLinux(): Promise<LiveSnapshot> {
	const apps = await listGuiWindowsLinux();
	const result = await run("ps", ["-eo", "pid=,ppid=,etimes=,tty=,args="]);
	if (!result.ok) {
		return { processes: [], tabs: [], consoleWindows: [], apps, error: result.error ?? "ps 执行失败" };
	}
	try {
		return { processes: classifyPsRows(parsePsOutput(result.out)), tabs: [], consoleWindows: [], apps };
	} catch (error) {
		return { processes: [], tabs: [], consoleWindows: [], apps, error: error instanceof Error ? error.message : String(error) };
	}
}
