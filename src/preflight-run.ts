/**
 * 会话启动前的自更新(默认前台,跑完才启动会话)。
 *
 * 用户要求(2026-10-01):"没必要检测,直接跑一遍所有 update 相关命令" ——
 * 因此这里**不做版本/变更检测**(不查 npm、不比对版本、不解析 Already up to date),
 * 每次启动按固定顺序把所有更新命令跑一遍,再用更新后的环境启动会话。
 *
 * 顺序(只更新 AI CLI 与它们的插件,不管其它项目):
 *   1) pi update
 *   2) pi update --extensions
 *   3) 其它 AI CLI + 插件:claude(本体 + 插件)、opencode、codex、gemini(尽力而为)
 *
 * 独立性(见 test/standalone.test.js 固化):ai-session-hub 是独立程序 ——
 * 不 git pull 别人的仓库,也不运行别人的 setup.sh。
 *
 * 环境坑:Windows 上 .cmd/.bat 不能被 execFile 直接执行,裸 bash 又可能落到 WSL ——
 * 所以**所有命令统一经 Git Bash 绝对路径执行**,并把 .cmd 路径用双引号包住。
 *
 * 逃生舱:AIS_NO_UPDATE=1 或 `ais --no-update` 完全跳过。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { appVersionSummary, hasGlobalDshCli, planDshCliStep, readAppVersions, type DshCliStatus } from "./apps.ts";
import { execRunner, preflight, type Runner, type Step } from "./preflight.ts";

const IS_WINDOWS = process.platform === "win32";
const PATH_SEP = IS_WINDOWS ? ";" : ":";

export interface StartOptions {
	disabled?: boolean;
	onProgress?: (message: string) => void;
}

/**
 * 执行更新命令用的 POSIX shell。Windows 上必须是 Git Bash 的绝对路径
 * (裸 `bash` 可能落到 WSL);类 Unix 上就是用户的 $SHELL / bash。
 */
export function resolvePreflightShell(): string | undefined {
	if (IS_WINDOWS) return resolveGitBash();
	for (const candidate of [(process.env.SHELL ?? "").trim(), "/bin/bash", "/usr/bin/bash", "/bin/sh"]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return undefined;
}

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

/**
 * pi 可执行文件。pnpm 10+ 的全局 bin(`<local>/pnpm/bin/pi`)优先:
 * 旧的 `<local>/pnpm/pi` shim 指向 global/5(旧版本),曾让 ais 拉起的会话一直跑旧 pi + 旧扩展集。
 */
export function resolvePi(): string {
	if (!IS_WINDOWS) {
		// 类 Unix:先看 PATH(pnpm/npm/bun 的 shim 都是可执行文件),再看 pnpm 的常见安装位置
		for (const dir of (process.env.PATH ?? "").split(PATH_SEP)) {
			if (!dir) continue;
			try {
				if (existsSync(`${dir}/pi`)) return `${dir}/pi`;
			} catch {
				/* 继续 */
			}
		}
		for (const candidate of [`${homedir()}/.local/share/pnpm/pi`, `${homedir()}/.local/bin/pi`, "/usr/local/bin/pi"]) {
			try {
				if (existsSync(candidate)) return candidate;
			} catch {
				/* 继续 */
			}
		}
		return "pi";
	}
	const local = process.env.LOCALAPPDATA ?? "";
	const roaming = process.env.APPDATA ?? "";
	for (const candidate of [`${local}/pnpm/bin/pi.CMD`, `${local}/pnpm/bin/pi`, `${local}/pnpm/pi.CMD`, `${local}/pnpm/pi`, `${roaming}/npm/pi.CMD`]) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			/* 继续 */
		}
	}
	return "pi";
}

/** 经 Git Bash 执行一条命令(可尽力而为:失败不计入失败项,也不拦住启动) */
function bashStep(
	label: string,
	bash: string,
	command: string,
	options: { best?: boolean; timeoutMs?: number; group?: string } = {},
): Step {
	const suffix = options.best ? " >/dev/null 2>&1 || true" : "";
	return { label, command: bash, args: ["-lc", command + suffix], timeoutMs: options.timeoutMs ?? 900_000, group: options.group };
}

/** 本机装了哪些 CLI(只给装了的排步骤) */
export function isInstalled(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (IS_WINDOWS) {
		const npmDir = `${env.APPDATA ?? ""}/npm`;
		if (existsSync(`${npmDir}/${bin}.cmd`)) return true;
	}
	const names = IS_WINDOWS ? [`${bin}.cmd`, bin] : [bin];
	return (env.PATH ?? "")
		.split(PATH_SEP)
		.filter(Boolean)
		.some((dir) => names.some((name) => existsSync(`${dir}/${name}`)));
}

/** 全部更新步骤(不检测,直接跑);没有 Git Bash 时返回空(不做半套) */
export function planUpdateSteps(input: { piBin: string; gitBash?: string }): Step[] {
	const bash = input.gitBash;
	if (!bash) return [];
	const quoted = `"${input.piBin}"`;
	// 分组:同一工具的两步保持先后顺序;不同工具并行(实测 4 步串行 11.7 秒 → 并行 ≈ 6 秒)
	const steps: Step[] = [
		bashStep("更新 pi 本体", bash, `${quoted} update`, { timeoutMs: 600_000, group: "pi" }),
		bashStep("更新 pi 扩展", bash, `${quoted} update --extensions`, { group: "pi" }),
	];
	const others: [string, string, string, string][] = [
		["claude", "claude update", "更新 Claude Code", "claude"],
		["claude", "claude plugin update", "更新 Claude 插件", "claude"],
		["opencode", "opencode upgrade", "更新 opencode", "opencode"],
		["codex", "npm i -g @openai/codex@latest", "更新 codex", "npm"],
		["gemini", "npm i -g @google/gemini-cli@latest", "更新 gemini", "npm"],
	];
	for (const [bin, command, label, group] of others) {
		if (!isInstalled(bin)) continue;
		steps.push(bashStep(label, bash, command, { best: true, group }));
	}
	return steps; // 独立程序:不拉别人的仓库,也不跑别人的 setup.sh
}

/** DSH 全局 CLI 的规划结果:要执行的步骤 + 摘要用的状态(0 或 1 个);runner/shell 可注入以便离线单测 */
export async function planDshCliSteps(
	runner: Runner = execRunner,
	npmAvailable = isInstalled("npm"),
	shell: string | undefined = resolvePreflightShell(),
): Promise<{ steps: Step[]; status: DshCliStatus }> {
	if (!npmAvailable || !shell) return { steps: [], status: "npm-missing" };
	const step = planDshCliStep({ npmAvailable: true, hasGlobalCli: await hasGlobalDshCli({ shell, runner }), shell });
	return step ? { steps: [step], status: "updated" } : { steps: [], status: "not-installed" };
}

/** 毫秒 → "12.3s" / "820ms" */
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 启动前自更新:不检测,直接跑全部更新命令;返回一行摘要(失败不抛) */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	try {
		if (options.disabled || process.env.AIS_NO_UPDATE === "1") return undefined;
		const shell = resolvePreflightShell();
		const steps = planUpdateSteps({ piBin: resolvePi(), gitBash: shell });
		if (steps.length === 0) return undefined;
		const dsh = await planDshCliSteps(execRunner, isInstalled("npm"), shell);
		steps.push(...dsh.steps);
		const say = options.onProgress ?? ((message: string) => process.stdout.write("[ais] " + message + "\n"));
		say("执行 " + steps.length + " 项更新…");
		const result = await preflight({
			steps,
			onProgress: say,
			onStepDone: ({ label, ok, ms, detail }) =>
				say(ok ? `${label} 完成(${formatDuration(ms)})` : `${label} 失败(${formatDuration(ms)})${detail ? ": " + detail : ""}`),
		});
		const failed = result.steps.filter((step) => !step.ok);
		const versions = await readAppVersions({ shell });
		return "[ais] 启动前自更新: " + result.summary + (failed.length ? "" : "(全部成功)") + ";" + appVersionSummary(versions, dsh.status);
	} catch (error) {
		return "[ais] 自更新跳过(" + (error instanceof Error ? error.message : String(error)) + ")";
	}
}
