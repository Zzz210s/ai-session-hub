/**
 * 启动前预检与自更新:让 ais 启动的会话总是跑在"最新的 pi + 最新的扩展 + 最新的配置"上。
 *
 * 起因(2026-09-30):ais 启动会话时用的 pi 来自硬编码候选路径,而那恰好是旧 pnpm shim
 * (~/AppData/Local/pnpm/pi -> global\5),于是即便已经 pi update,ais 拉起的会话仍然是
 * 旧版本 pi + 旧扩展集。同时也没有任何"启动前把配置仓库拉新并重新部署"的动作。
 *
 * 设计:
 *   - 自更新按 TTL 缓存(默认 6 小时),避免每次启动都等;--update 强制、--no-update / AIS_NO_UPDATE=1 关闭
 *   - 每一步失败不致命:网络不可用/离线时静默跳过,照常启动会话(只记录摘要)
 *   - 顺序:拉配置仓库 -> pi 自更新 -> 扩展更新 -> 重新部署(setup.sh) -> 体检(verify.sh,只报告)
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Step {
	label: string;
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface PreflightState {
	at: number;
	summary: string;
}

export interface PreflightResult {
	ran: boolean;
	reason: string;
	summary: string;
	steps: { label: string; ok: boolean; detail?: string }[];
}

export type Runner = (command: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string }>;

/** 需要"拉新再重新部署"的配置仓库(存在才处理) */
export const CONFIG_REPOS = ["config-ai", "config-cli", "pi-tab-status", "pi-codegraph", "ai-session-hub", "brief-hub"] as const;

export function statePath(home = homedir()): string {
	return join(home, ".ai-session-hub", "cache", "preflight.json");
}

export function readState(path = statePath()): PreflightState | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as PreflightState;
		return typeof raw?.at === "number" ? raw : undefined;
	} catch {
		return undefined;
	}
}

export function writeState(state: PreflightState, path = statePath()): void {
	try {
		writeFileSync(path, JSON.stringify(state, null, "\t"));
	} catch {
		/* 缓存写不进去不影响功能 */
	}
}

/** 是否该执行自更新(纯函数,便于单测) */
export function shouldRun(
	state: PreflightState | undefined,
	now: number,
	opts: { force?: boolean; disabled?: boolean; ttlMs?: number } = {},
): { run: boolean; reason: string } {
	if (opts.disabled) return { run: false, reason: "已按开关禁用(AIS_NO_UPDATE=1 / --no-update)" };
	if (opts.force) return { run: true, reason: "按 --update 强制执行" };
	const ttl = opts.ttlMs ?? 6 * 3600_000;
	if (!state) return { run: true, reason: "首次运行" };
	const age = now - state.at;
	if (age >= ttl) return { run: true, reason: `距上次已 ${Math.round(age / 3600_000)} 小时` };
	return { run: false, reason: `上次 ${Math.round(age / 60_000)} 分钟前刚检查过(${state.summary})` };
}

/** 组装要执行的步骤(纯函数,便于单测) */
export function planSteps(options: { home?: string; piBin?: string; bash?: string } = {}): Step[] {
	const home = options.home ?? homedir();
	const piBin = options.piBin ?? "pi";
	const bash = options.bash ?? "bash";
	const steps: Step[] = [];
	for (const repo of CONFIG_REPOS) {
		const dir = join(home, repo);
		if (!existsSync(dir)) continue;
		steps.push({ label: `拉新 ${repo}`, command: "git", args: ["-C", dir, "pull", "--ff-only", "--quiet"], timeoutMs: 120_000 });
	}
	steps.push({ label: "更新 pi 本体", command: piBin, args: ["update"], timeoutMs: 300_000 });
	steps.push({ label: "更新扩展", command: piBin, args: ["update", "--extensions"], timeoutMs: 600_000 });
	const setup = join(home, "config-ai", "setup.sh");
	if (existsSync(setup)) steps.push({ label: "重新部署配置", command: bash, args: [setup], timeoutMs: 600_000 });
	const verify = join(home, "config-ai", "verify.sh");
	if (existsSync(verify)) steps.push({ label: "配置体检", command: bash, args: [verify], timeoutMs: 300_000 });
	return steps;
}

/** 默认执行器:带超时,静默失败(返回 ok=false 而不抛) */
export const execRunner: Runner = (command, args, timeoutMs) =>
	new Promise((resolve) => {
		try {
			execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				resolve({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
			});
		} catch (error) {
			resolve({ ok: false, out: String(error) });
		}
	});

export interface PreflightOptions {
	force?: boolean;
	disabled?: boolean;
	ttlMs?: number;
	now?: number;
	runner?: Runner;
	onProgress?: (message: string) => void;
	steps?: Step[];
	stateFile?: string;
}

/** 执行预检与自更新;任何步骤失败都不抛,只在摘要里体现 */
export async function preflight(options: PreflightOptions = {}): Promise<PreflightResult> {
	const now = options.now ?? Date.now();
	const state = readState(options.stateFile);
	const decision = shouldRun(state, now, options);
	if (!decision.run) return { ran: false, reason: decision.reason, summary: state?.summary ?? "", steps: [] };

	const run = options.runner ?? execRunner;
	const steps = options.steps ?? planSteps();
	const results: PreflightResult["steps"] = [];
	for (const step of steps) {
		options.onProgress?.(`${step.label}…`);
		const { ok, out } = await run(step.command, step.args, step.timeoutMs);
		results.push({ label: step.label, ok, detail: ok ? undefined : out.split("\n").slice(-2).join(" ").slice(0, 160) });
	}

	const okCount = results.filter((r) => r.ok).length;
	const failed = results.filter((r) => !r.ok);
	const summary = failed.length === 0 ? `${results.length} 步全部完成` : `${okCount}/${results.length} 步完成,失败: ${failed.map((f) => f.label).join("、")}`;
	writeState({ at: now, summary }, options.stateFile);
	return { ran: true, reason: decision.reason, summary, steps: results };
}

/** CLI 侧胶水:解析 --update / --no-update 与环境开关,打印一行摘要(失败不阻断启动) */
export async function cliPreflight(flags: { update?: boolean; noUpdate?: boolean }): Promise<string | undefined> {
	try {
		const result = await preflight({
			force: Boolean(flags.update),
			disabled: Boolean(flags.noUpdate) || process.env.AIS_NO_UPDATE === "1",
		});
		if (!result.ran) return undefined;
		return `[ais] 启动前自更新: ${result.summary}`;
	} catch {
		return undefined;
	}
}
