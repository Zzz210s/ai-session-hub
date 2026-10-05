/**
 * Linux 侧的短命令执行原语(wmctrl / xdotool / ps 共用)。
 * 独立成文件:linux.ts 与 linux-focus.ts 都要用,放任何一侧都会成环。
 */

import { execFile } from "node:child_process";

export interface RunResult {
	ok: boolean;
	out: string;
	error?: string;
}

/** 跑一条短命令并收集 stdout(timeout 到点即失败,不抛异常) */
export function run(file: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
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
