/**
 * 预检的后台化外壳:TUI 立即启动,自更新放到 detached 子进程里跑;
 * 下一次启动只读状态文件并给一行提示(已更新 / 有更新 / 上次失败)。
 *
 * 为什么这样设计:自更新是"维护动作"(git pull + pi update + 扩展更新,分钟级),
 * 不该拦住"打开看板"。用户选择 A1:后台跑,不阻塞。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readState, shouldRun } from "./preflight.ts";

export interface StartOptions {
	force?: boolean;
	disabled?: boolean;
	ttlMs?: number;
	now?: number;
}

/** 后台命令:直接跑 preflight-bg.ts,不经过 cli.ts */
export function backgroundCommand(now = Date.now()): { command: string; args: string[] } {
	const script = fileURLToPath(new URL("./preflight-bg.ts", import.meta.url));
	return { command: process.execPath, args: ["--no-warnings", script] };
}

/** 提示文案(纯函数,便于单测) */
export function hintFor(state: { at: number; summary: string } | undefined, now: number): string | undefined {
	if (!state) return undefined;
	const ageMin = Math.round((now - state.at) / 60_000);
	if (ageMin > 24 * 60) return undefined;
	const when = ageMin < 1 ? "刚刚" : ageMin < 60 ? ageMin + " 分钟前" : Math.round(ageMin / 60) + " 小时前";
	return "[ais] 上次启动前自更新(" + when + "): " + state.summary;
}

/** 启动预检:默认后台派发并立即返回;--update 时前台执行(用户明确要求等待结果) */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	const now = options.now ?? Date.now();
	if (options.disabled) return undefined;
	const state = readState();
	if (options.force) {
		const { preflight } = await import("./preflight.ts");
		const result = await preflight({ force: true });
		return result.ran ? "[ais] 启动前自更新: " + result.summary : undefined;
	}
	if (shouldRun(state, now, options).run) spawnDetached();
	return hintFor(state, now);
}

/** 派发 detached 子进程:失败一律静默(宁可少一次更新,也不能拦住启动) */
function spawnDetached(): void {
	try {
		const { command, args } = backgroundCommand();
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.unref();
	} catch {
		/* 忽略:后台更新失败不影响本次启动 */
	}
}
