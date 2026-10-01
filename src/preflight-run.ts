/**
 * 会话启动前的自更新(默认前台)。
 *
 * 用户要求(2026-10-01):"没必要检测,直接跑一遍所有 update 相关命令" ——
 * 因此这里**不再做版本/变更检测**(不查 npm、不比对版本、不解析 Already up to date),
 * 每次启动按固定顺序把所有更新命令跑一遍,再用更新后的环境启动会话。
 *
 * 顺序:
 *   1) git pull 各配置仓库(config-ai / config-cli / 三个独立扩展 / brief-hub,存在才做)
 *   2) pi update
 *   3) pi update --extensions
 *   4) 其它 AI CLI + 插件:claude(本体 + 插件)、opencode、codex、gemini(尽力而为)
 *   5) config-ai/setup.sh 重新部署(把最新配置投射到各 CLI)
 *
 * 环境坑:Windows 上 .cmd/.bat 不能被 execFile 直接执行,裸 bash 又可能落到 WSL ——
 * 所以**所有命令统一经 Git Bash 绝对路径执行**,并把 .cmd 路径用双引号包住。
 *
 * 逃生舱:AIS_NO_UPDATE=1 全跳;AIS_SKIP_DEPLOY=1 只更新不重新部署(省最多时间);
 *         AIS_UPDATE_BACKGROUND=1 退回后台模式(下次启动只提示一行)。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execRunner, preflight, readState, shouldRun, type Step } from "./preflight.ts";

export interface StartOptions {
	force?: boolean;
	disabled?: boolean;
	ttlMs?: number;
	now?: number;
	background?: boolean;
	onProgress?: (message: string) => void;
}

const VERSION = /(\d+\.\d+\.\d+)/;

/** 配置仓库(存在才处理) */
export const CONFIG_REPOS = ["config-ai", "config-cli", "pi-tab-status", "pi-codegraph", "ai-session-hub", "brief-hub"] as const;

/** Git Bash 绝对路径(避免落到 WSL 的 bash) */
export function resolveGitBash(): string | undefined {
	const pf = process.env.ProgramFiles ?? "C:/Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
	for (const candidate of [`${pf}/Git/bin/bash.exe`, `${pf86}/Git/bin/bash.exe`]) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return undefined;
}

/** pi 可执行:pnpm 新布局优先,旧 shim 指向旧版本 */
export function resolvePi(): string {
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	for (const candidate of [`${local}/pnpm/bin/pi.CMD`, `${local}/pnpm/bin/pi`, `${local}/pnpm/pi.CMD`, `${roaming}/npm/pi.CMD`]) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return "pi";
}

/** npm 可执行(Windows 上是 .cmd;仅用于版本探测等可选功能) */
export function resolveNpm(): string {
	const roaming = process.env.APPDATA ?? "";
	for (const candidate of [`${roaming}/npm/npm.cmd`, `${roaming}/npm/npm`]) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return "npm";
}

/** 经 Git Bash 执行一条命令(可尽力而为:失败不计入失败项) */
function bashStep(label: string, bash: string, command: string, options: { best?: boolean; timeoutMs?: number } = {}): Step {
	const suffix = options.best ? " >/dev/null 2>&1 || true" : "";
	return { label, command: bash, args: ["-lc", command + suffix], timeoutMs: options.timeoutMs ?? 900_000 };
}

/** 全部更新步骤(不检测,直接跑) */
export function planUpdateSteps(input: { piBin: string; gitBash?: string; home?: string; skipDeploy?: boolean }): Step[] {
	const home = input.home ?? process.env.USERPROFILE ?? "";
	const bash = input.gitBash;
	const steps: Step[] = [];
	for (const repo of CONFIG_REPOS) {
		const dir = `${home}/${repo}`;
		try {
			if (!existsSync(dir)) continue;
		} catch {
			continue;
		}
		// git 是 .exe,可直接执行;但仍走同一执行器,失败会如实显示
		steps.push({ label: `拉新 ${repo}`, command: "git", args: ["-C", dir, "pull", "--ff-only", "--quiet"], timeoutMs: 120_000 });
	}
	if (!bash) return steps; // 没有 Git Bash 时只做 git pull(其余命令无法安全执行)
	const quoted = `"${input.piBin}"`;
	steps.push(bashStep("更新 pi 本体", bash, `${quoted} update`, { timeoutMs: 600_000 }));
	steps.push(bashStep("更新 pi 扩展", bash, `${quoted} update --extensions`));
	const npmDir = `${process.env.APPDATA ?? ""}/npm`;
	const others: [string, string, string][] = [
		["claude", "claude update", "更新 Claude Code"],
		["claude", "claude plugin update", "更新 Claude 插件"],
		["opencode", "opencode upgrade", "更新 opencode"],
		["codex", "npm i -g @openai/codex@latest", "更新 codex"],
		["gemini", "npm i -g @google/gemini-cli@latest", "更新 gemini"],
	];
	for (const [bin, command, label] of others) {
		const installed = existsSync(`${npmDir}/${bin}.cmd`) || (process.env.PATH ?? "").split(";").some((dir) => dir && existsSync(`${dir}/${bin}.cmd`));
		if (!installed) continue;
		steps.push(bashStep(label, bash, command, { best: true }));
	}
	if (!input.skipDeploy) {
		const setup = `${home}/config-ai/setup.sh`;
		try {
			if (existsSync(setup)) steps.push(bashStep("重新部署配置", bash, `"${setup}"`, { timeoutMs: 900_000 }));
		} catch {
			/* 忽略 */
		}
	}
	return steps;
}

/** 后台命令:跑 preflight-bg.ts */
export function backgroundCommand(): { command: string; args: string[] } {
	const script = fileURLToPath(new URL("./preflight-bg.ts", import.meta.url));
	return { command: process.execPath, args: ["--no-warnings", script] };
}

/** 上次自更新的提示(24 小时内才提示) */
export function hintFor(state: { at: number; summary: string } | undefined, now: number): string | undefined {
	if (!state) return undefined;
	const ageMin = Math.round((now - state.at) / 60_000);
	if (ageMin > 24 * 60) return undefined;
	const when = ageMin < 1 ? "刚刚" : ageMin < 60 ? ageMin + " 分钟前" : Math.round(ageMin / 60) + " 小时前";
	return "[ais] 上次启动前自更新(" + when + "): " + state.summary;
}

/** 版本探测(保留:供诊断使用;不再参与启动决策) */
export async function localPiVersion(bin = "pi"): Promise<string | undefined> {
	const bash = resolveGitBash();
	const step = bash ? bashStep("version", bash, `"${bin}" --version`, { timeoutMs: 60_000 }) : { command: bin, args: ["--version"], timeoutMs: 60_000 };
	const { ok, out } = await execRunner(step.command, step.args, step.timeoutMs);
	if (!ok) return undefined;
	const m = out.match(VERSION);
	return m ? m[1] : undefined;
}

export async function latestPiVersion(): Promise<string | undefined> {
	const bash = resolveGitBash();
	const command = `"${resolveNpm()}" view @earendil-works/pi-coding-agent version`;
	const step = bash ? bashStep("latest", bash, command, { timeoutMs: 60_000 }) : { command: resolveNpm(), args: ["view", "@earendil-works/pi-coding-agent", "version"], timeoutMs: 60_000 };
	const { ok, out } = await execRunner(step.command, step.args, step.timeoutMs);
	if (!ok) return undefined;
	const m = out.match(VERSION);
	return m ? m[1] : undefined;
}

/** 保留:后台模式的 TTL 判断(仅 AIS_UPDATE_BACKGROUND=1 时使用) */
export function needsDeploy(input: { reposChanged?: boolean; piChanged?: boolean; state?: { at: number }; now: number; ttlMs?: number }): boolean {
	if (input.reposChanged || input.piChanged) return true;
	const ttl = input.ttlMs ?? 24 * 3600_000;
	return !input.state || input.now - input.state.at >= ttl;
}

function spawnDetached(): void {
	try {
		const { command, args } = backgroundCommand();
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.unref();
	} catch {
		/* 后台更新失败不影响启动 */
	}
}

/** 启动前自更新:不检测,直接跑全部更新命令;返回一行摘要 */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	try {
		const now = options.now ?? Date.now();
		if (options.disabled || process.env.AIS_NO_UPDATE === "1") return undefined;
		const say = options.onProgress ?? ((message: string) => process.stdout.write("[ais] " + message + "\n"));

		if ((options.background ?? process.env.AIS_UPDATE_BACKGROUND === "1") && !options.force) {
			const state = readState();
			if (shouldRun(state, now, options).run) spawnDetached();
			return hintFor(state, now);
		}

		const gitBash = resolveGitBash();
		const steps = planUpdateSteps({
			piBin: resolvePi(),
			gitBash,
			skipDeploy: process.env.AIS_SKIP_DEPLOY === "1",
		});
		if (steps.length === 0) return undefined;

		say("执行 " + steps.length + " 项更新…");
		const result = await preflight({ force: true, steps, now });
		const failed = result.steps.filter((step) => !step.ok).map((step) => step.label);
		return "[ais] 启动前自更新: " + result.summary + (failed.length ? "" : "(全部成功)");
	} catch (error) {
		return "[ais] 自更新跳过(" + (error instanceof Error ? error.message : String(error)) + ")";
	}
}
