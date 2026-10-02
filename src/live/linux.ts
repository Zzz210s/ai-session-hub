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

import { execFile, spawn } from "node:child_process";
import type { LiveProcess, LiveSnapshot } from "../model.ts";
import { classifyProcess } from "./classify.ts";

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

function run(file: string, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; out: string; error?: string }> {
	return new Promise((resolve) => {
		try {
			execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) resolve({ ok: false, out: String(stdout ?? ""), error: String(stderr || error.message) });
				else resolve({ ok: true, out: String(stdout ?? "") });
			});
		} catch (error) {
			resolve({ ok: false, out: "", error: error instanceof Error ? error.message : String(error) });
		}
	});
}

/** 是否有某个命令(用于 wmctrl/xdotool/tmux 的能力探测) */
export async function hasCommand(name: string): Promise<boolean> {
	const result = await run("sh", ["-c", `command -v ${name} >/dev/null 2>&1`], 5000);
	return result.ok;
}

export async function probeLiveLinux(): Promise<LiveSnapshot> {
	const result = await run("ps", ["-eo", "pid=,ppid=,etimes=,tty=,args="]);
	if (!result.ok) {
		return { processes: [], tabs: [], consoleWindows: [], error: result.error ?? "ps 执行失败" };
	}
	try {
		return { processes: classifyPsRows(parsePsOutput(result.out)), tabs: [], consoleWindows: [] };
	} catch (error) {
		return { processes: [], tabs: [], consoleWindows: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Linux 聚焦:wmctrl / xdotool 按窗口标题匹配(取第一个命中的窗口) */
export async function focusWindowLinux(title: string): Promise<{ ok: boolean; detail: string }> {
	const needle = title.trim();
	if (!needle) return { ok: false, detail: "没有可匹配的窗口标题(会话名/心跳缺失)" };

	if (await hasCommand("wmctrl")) {
		const activated = await run("wmctrl", ["-a", needle]);
		if (activated.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		const listed = await run("wmctrl", ["-l"]);
		const hit = listed.out.split(/\r?\n/).find((line) => line.includes(needle));
		const id = hit?.trim().split(/\s+/)[0];
		if (id) {
			const byId = await run("wmctrl", ["-i", "-a", id]);
			if (byId.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		}
		return { ok: false, detail: `wmctrl 没找到标题含「${needle}」的窗口` };
	}

	if (await hasCommand("xdotool")) {
		const search = await run("xdotool", ["search", "--name", needle]);
		const id = search.out.split(/\r?\n/).find((line) => line.trim());
		if (id) {
			const activated = await run("xdotool", ["windowactivate", id.trim()]);
			if (activated.ok) return { ok: true, detail: `已聚焦窗口:${needle}` };
		}
		return { ok: false, detail: `xdotool 没找到标题含「${needle}」的窗口` };
	}

	return { ok: false, detail: "Linux 下聚焦窗口需要 wmctrl 或 xdotool(装一个即可)" };
}

/**
 * 新开一个终端跑命令:Linux 优先 tmux 新窗口,其次 $TERMINAL / x-terminal-emulator。
 * 同步返回:spawn 只能报"起不来"这种错误,窗口是否真的出现由用户判断(失败时提示用 c 复制命令)。
 */
export function openInNewTerminal(command: string, cwd: string): { ok: boolean; detail: string } {
	try {
		if (process.env.TMUX) {
			const child = spawn("tmux", ["new-window", "-c", cwd, command], { detached: true, stdio: "ignore" });
			child.unref();
			return { ok: true, detail: "已在 tmux 新窗口打开" };
		}
		const terminal = (process.env.TERMINAL ?? "").trim() || "x-terminal-emulator";
		const child = spawn(terminal, ["-e", command], { detached: true, stdio: "ignore", cwd });
		child.unref();
		return { ok: true, detail: `已用 ${terminal} 打开(若无反应,按 c 复制命令手贴)` };
	} catch (error) {
		return { ok: false, detail: `新终端启动失败:${error instanceof Error ? error.message : String(error)}(可设 $TERMINAL,或按 c 复制命令)` };
	}
}
