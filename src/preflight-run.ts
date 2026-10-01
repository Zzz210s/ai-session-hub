/**
 * 会话启动前的自更新(默认前台):覆盖本机**所有 AI CLI 及其插件**。
 *
 * 需求(2026-10-01):"检测所有会话对应使用的 llm/cli 的更新和他们插件的更新",
 * 并在"更新完成后再用更新后的配置启动会话"。
 *
 * 三层门控(避免每次启动都付全量更新的时间):
 *   1) 配置仓库逐个 git pull(识别 "Already up to date")
 *   2) 本地 pi 版本 vs npm 最新版,不同才 pi update
 *   3) 扩展/其它 CLI/插件/重新部署,仅在 (仓库有变化 || pi 有新版 || 距上次 >24h)
 *
 * 环境坑与对策(均为实测):
 *   - Windows 上裸 bash 可能落到 WSL(System32\bash.exe) -> 用 Git Bash 绝对路径
 *   - **execFile 不能直接执行 .cmd/.bat**(Node 只补 .exe)-> 统一经 cmd.exe /c 转发
 *   - pi 必须用 pnpm 新布局(pnpm/bin/pi),旧 shim 指向旧版本
 *
 * 逃生舱:AIS_NO_UPDATE=1 跳过;AIS_UPDATE_BACKGROUND=1 退回后台模式。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

const UP_TO_DATE = /Already up to date|up to date|已是最新|already up-to-date/i;
const VERSION = /(\d+\.\d+\.\d+)/;

/** Windows 上 .cmd/.bat 不能被 execFile 直接执行:经 cmd.exe /c 转发 */
export function shimSafe(step: Step): Step {
	if (process.platform !== "win32") return step;
	if (!/\.(cmd|bat)$/i.test(step.command)) return step;
	const comspec = process.env.ComSpec ?? "cmd.exe";
	const quoted = [step.command, ...step.args].map((part) => `"${part}"`).join(" ");
	return { ...step, command: comspec, args: ["/d", "/s", "/c", quoted] };
}

/** Git Bash 绝对路径(避免落到 WSL 的 bash) */
export function resolveGitBash(): string | undefined {
	const programFiles = process.env.ProgramFiles ?? "C:/Program Files";
	const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
	for (const candidate of [`${programFiles}/Git/bin/bash.exe`, `${programFilesX86}/Git/bin/bash.exe`]) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return undefined;
}

/** pi 可执行:pnpm 新布局 -> 旧 shim -> npm 全局 -> 裸 pi */
export function resolvePi(): string {
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	const candidates = [`${local}/pnpm/bin/pi.CMD`, `${local}/pnpm/bin/pi`, `${local}/pnpm/pi.CMD`, `${local}/pnpm/pi`, `${roaming}/npm/pi.CMD`];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return "pi";
}

/** npm 可执行(Windows 上是 .cmd,需要 shimSafe 转发) */
export function resolveNpm(): string {
	const roaming = process.env.APPDATA ?? "";
	const candidates = [`${roaming}/npm/npm.cmd`, `${roaming}/npm/npm`];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return "npm";
}

/** 所有 AI CLI + 插件的更新步骤:只对已安装的工具生成;pi 严格,其它尽力而为 */
export function toolUpdateSteps(input: { piBin: string; gitBash?: string; piChanged?: boolean }): Step[] {
	const steps: Step[] = [];
	if (input.piChanged !== false) {
		steps.push(shimSafe({ label: "更新 pi 本体", command: input.piBin, args: ["update"], timeoutMs: 300_000 }));
	}
	steps.push(shimSafe({ label: "更新 pi 扩展", command: input.piBin, args: ["update", "--extensions"], timeoutMs: 900_000 }));

	if (input.gitBash) {
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
			// 尽力而为:失败不阻断、也不计入失败项
			steps.push({ label, command: input.gitBash, args: ["-lc", `${command} >/dev/null 2>&1 || true`], timeoutMs: 900_000 });
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

/** 版本号探测(经 shimSafe:Windows 上的 .cmd 也能跑) */
async function version(bin: string, args: string[]): Promise<string | undefined> {
	const step = shimSafe({ label: "version", command: bin, args, timeoutMs: 60_000 });
	const { ok, out } = await execRunner(step.command, step.args, step.timeoutMs);
	if (!ok) return undefined;
	const m = out.match(VERSION);
	return m ? m[1] : undefined;
}

export async function localPiVersion(bin = "pi"): Promise<string | undefined> {
	return version(bin, ["--version"]);
}

export async function latestPiVersion(): Promise<string | undefined> {
	return version(resolveNpm(), ["view", "@earendil-works/pi-coding-agent", "version"]);
}

/** 是否需要重新部署(纯函数) */
export function needsDeploy(input: { reposChanged: boolean; piChanged: boolean; state?: { at: number }; now: number; ttlMs?: number }): boolean {
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

/** 启动前自更新。返回一行字符串(无动作时 undefined);任何异常都不抛出。 */
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
		const piBin = resolvePi();
		const all = planSteps(gitBash ? { piBin, bash: gitBash } : { piBin });
		const pulls = all.filter((step) => step.label.startsWith("拉新"));

		say("检查配置仓库…");
		let reposChanged = false;
		for (const step of pulls) if (await runQuiet(step)) reposChanged = true;

		say("检查 pi 版本…");
		const [local, remote] = await Promise.all([localPiVersion(piBin), latestPiVersion()]);
		const piChanged = Boolean(local && remote && local !== remote);

		if (!needsDeploy({ reposChanged, piChanged, state: readState(), now, ttlMs: options.ttlMs })) {
			return "[ais] 已是最新(" + (local ?? "版本未知") + "),跳过自更新";
		}

		const redeploy = all.filter((step) => step.label === "重新部署配置").map(shimSafe);
		const steps = [...toolUpdateSteps({ piBin, gitBash, piChanged }), ...redeploy];
		say("应用更新(" + steps.length + " 步)…");
		const result = await preflight({ force: true, steps, now });
		const what = [reposChanged ? "配置" : undefined, piChanged ? "pi" : undefined].filter(Boolean).join("+") || "定时刷新";
		return "[ais] 启动前自更新(" + what + "): " + result.summary;
	} catch (error) {
		return "[ais] 自更新跳过(" + (error instanceof Error ? error.message : String(error)) + ")";
	}
}

/** 跑一步并判断是否产生变化(git pull 无变化时输出含 Already up to date) */
async function runQuiet(step: Step): Promise<boolean> {
	const safe = shimSafe(step);
	const { ok, out } = await execRunner(safe.command, safe.args, safe.timeoutMs);
	return ok && !UP_TO_DATE.test(out);
}
