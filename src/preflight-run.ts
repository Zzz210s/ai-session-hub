/**
 * 会话启动前的自更新(同步,默认前台):确保 ais 拉起的会话跑在最新 CLI + 最新插件 + 最新配置上。
 *
 * 需求(2026-10-01):"启动前自动检测自动更新所有可更新配置,然后再用更新后配置启动会话"。
 * 因此默认**前台执行**;但为了不每次都等几分钟,做了三层"只在该更新时才更新":
 *
 *   1) 配置仓库:逐个 git pull(无变化时 <1s/个),记录是否有新提交
 *   2) pi 本体:先比 "本地 --version" 与 "npm 最新版",不同才执行 pi update
 *   3) 扩展 + 重新部署:仅当 (仓库有新提交 || pi/扩展有更新 || 距上次检查超过 TTL) 才跑
 *      —— setup.sh 重新部署是最贵的一步,不该每次启动都付
 *
 * 逃生舱:AIS_NO_UPDATE=1 / ais --no-update 完全跳过;
 *         AIS_UPDATE_BACKGROUND=1 / ais --background 退回后台模式(只在下一次启动提示)。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execRunner, planSteps, preflight, readState, shouldRun, type Step } from "./preflight.ts";

export interface StartOptions {
	force?: boolean;
	disabled?: boolean;
	ttlMs?: number;
	now?: number;
	background?: boolean;
	onProgress?: (message: string) => void;
}

export interface StartResult {
	/** 给用户看的一行摘要 */
	line: string;
	/** 本次是否真的执行了更新动作 */
	updated: boolean;
}

const UP_TO_DATE = /Already up to date|up to date|当前分支.*最新|already up-to-date/i;
const VERSION = /(\d+\.\d+\.\d+)/;

/** 后台命令:直接跑 preflight-bg.ts,不经过 cli.ts */
export function backgroundCommand(): { command: string; args: string[] } {
	const script = fileURLToPath(new URL("./preflight-bg.ts", import.meta.url));
	return { command: process.execPath, args: ["--no-warnings", script] };
}

/** 提示文案(纯函数) */
export function hintFor(state: { at: number; summary: string } | undefined, now: number): string | undefined {
	if (!state) return undefined;
	const ageMin = Math.round((now - state.at) / 60_000);
	if (ageMin > 24 * 60) return undefined;
	const when = ageMin < 1 ? "刚刚" : ageMin < 60 ? ageMin + " 分钟前" : Math.round(ageMin / 60) + " 小时前";
	return "[ais] 上次启动前自更新(" + when + "): " + state.summary;
}

/** 本地 pi 版本(取不到返回 undefined) */
export async function localPiVersion(bin = "pi"): Promise<string | undefined> {
	const { ok, out } = await execRunner(bin, ["--version"], 30_000);
	if (!ok) return undefined;
	const m = out.match(VERSION);
	return m ? m[1] : undefined;
}

/** npm 上的最新版本(离线或失败返回 undefined) */
export async function latestPiVersion(npm = "npm"): Promise<string | undefined> {
	const { ok, out } = await execRunner(npm, ["view", "@earendil-works/pi-coding-agent", "version"], 60_000);
	if (!ok) return undefined;
	const m = out.match(VERSION);
	return m ? m[1] : undefined;
}

/** 决定模型清单等配置是否需要刷新(纯函数):有仓库更新、pi 有新版、或超过 TTL */
export function needsDeploy(input: { reposChanged: boolean; piChanged: boolean; state?: { at: number }; now: number; ttlMs?: number }): boolean {
	if (input.reposChanged || input.piChanged) return true;
	const ttl = input.ttlMs ?? 24 * 3600_000;
	return !input.state || input.now - input.state.at >= ttl;
}

/** 派发 detached 子进程(失败静默) */
function spawnDetached(): void {
	try {
		const { command, args } = backgroundCommand();
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.unref();
	} catch {
		/* 后台更新失败不影响启动 */
	}
}

/**
 * 启动前自更新。默认前台执行并返回一行摘要;`AIS_UPDATE_BACKGROUND=1` 时改为后台。
 * 任何失败都只反映在摘要里,不抛异常。
 */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	const now = options.now ?? Date.now();
	if (options.disabled) return undefined;
	const progress = options.onProgress ?? ((message: string) => process.stdout.write("[ais] " + message + "\n"));

	const wantsBackground = options.background ?? process.env.AIS_UPDATE_BACKGROUND === "1";
	if (wantsBackground && !options.force) {
		const state = readState();
		if (shouldRun(state, now, options).run) spawnDetached();
		const hint = hintFor(state, now);
		return hint;
	}

	const all = planSteps();
	const pulls = all.filter((step) => step.label.startsWith("拉新"));
	const deployish = all.filter((step) => !step.label.startsWith("拉新") && step.label !== "配置体检");

	progress("检查配置仓库…");
	let reposChanged = false;
	for (const step of pulls) reposChanged = (await runQuiet(step)) || reposChanged;

	progress("检查 pi 版本…");
	const [local, remote] = await Promise.all([localPiVersion(), latestPiVersion()]);
	const piChanged = Boolean(local && remote && local !== remote);

	if (!needsDeploy({ reposChanged, piChanged, state: readState(), now, ttlMs: options.ttlMs })) {
		return "[ais] 已是最新(" + (local ?? "版本未知") + "),跳过自更新";
	}

	const steps: Step[] = deployish.filter((step) => {
		if (step.label === "更新 pi 本体") return piChanged;
		return true;
	});
	progress("应用更新(" + steps.length + " 步)…");
	const result = await preflight({ force: true, steps, now });
	const what = [reposChanged ? "配置" : undefined, piChanged ? "pi" : undefined].filter(Boolean).join("+") || "定时刷新";
	return { line: "[ais] 启动前自更新(" + what + "): " + result.summary, updated: true };
}

/** 跑一步并判断是否产生变化(git pull 无变化时输出含 Already up to date) */
async function runQuiet(step: Step): Promise<boolean> {
	const { ok, out } = await execRunner(step.command, step.args, step.timeoutMs);
	return ok && !UP_TO_DATE.test(out);
}
