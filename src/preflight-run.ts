/**
 * 会话启动前的自更新(默认前台,跑完才启动会话)。
 *
 * 用户要求(2026-10-01):"没必要检测,直接跑一遍所有 update 相关命令" ——
 * 因此这里**不做版本比对**(不查 npm、不比对版本、不解析 Already up to date),
 * 按固定顺序把所有更新命令跑一遍,再用更新后的环境启动会话。
 *
 * 用户要求(2026-10-05):"ais 启动太慢" —— 实测一次完整自更新 10-14 秒,而这几条命令
 * 即使已是最新也要各自去 npm 走一趟元数据。因此加了 **TTL 跳过**:上次全部成功的时间
 * 戳记在 `~/.ai-session-hub/preflight-state.json`,TTL(默认 6h)内整段跳过,过期才跑。
 * 仍然不比对版本(跨安装方式易碎),只看时间戳;细节与旧决策的关系见 preflight-ttl.ts。
 * 任何一步失败都不写时间戳,所以下次启动会立刻重试。
 *
 * 顺序(只更新 AI CLI 与它们的插件,不管其它项目):
 *   1) pi update
 *   2) pi update --extensions
 *   3) 其它 AI CLI + 插件:claude(本体 + 插件)、opencode、codex、gemini(尽力而为)
 *
 * 独立性(见 test/standalone.test.js 固化):ai-session-hub 是独立程序 ——
 * 不 git pull 别人的仓库,也不运行别人的 setup.sh。
 *
 * 环境坑(shell / pi 路径 / 装了哪些 CLI)在 preflight-env.ts:所有命令统一经
 * **Git Bash 绝对路径**执行,并把 .cmd 路径用双引号包住。
 *
 * 逃生舱:AIS_NO_UPDATE=1 或 `ais --no-update` 完全跳过(连跳过行都不打印);
 *         AIS_UPDATE_TTL=0 表示每次都完整跑一遍。
 */

import { appVersionSummary, hasGlobalDshCli, planDshCliStep, readAppVersions, type DshCliStatus } from "./apps.ts";
import { formatDuration, isInstalled, resolvePi, resolvePreflightShell } from "./preflight-env.ts";
import { parseTtl, readPreflightState, skipReason, stateFilePath, writePreflightState } from "./preflight-ttl.ts";
import { execRunner, preflight, type Runner, type Step } from "./preflight.ts";

// 兼容既有导入路径(测试与 cli 都从本模块取这些)
export { formatDuration, isInstalled, resolveGitBash, resolvePi, resolvePreflightShell } from "./preflight-env.ts";

export interface StartOptions {
	disabled?: boolean;
	onProgress?: (message: string) => void;
	/** 执行更新命令的 runner(测试注入,默认真跑) */
	runner?: Runner;
	/** preflight 实现(测试注入,默认真跑) */
	runPreflight?: typeof preflight;
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

/**
 * 启动前自更新:TTL 内跳过,否则按固定顺序跑全部更新命令;返回一行摘要(失败不抛)。
 * 不比对版本 —— 只看"上次全部成功"的时间戳(TTL 语义见 preflight-ttl.ts)。
 */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	let versionsPromise: Promise<Record<string, string>> | undefined;
	try {
		if (options.disabled || process.env.AIS_NO_UPDATE === "1") return undefined;
		const statePath = stateFilePath();
		const skip = skipReason(readPreflightState(statePath), Date.now(), parseTtl(process.env.AIS_UPDATE_TTL));
		if (skip) return "[ais] 启动前自更新: " + skip;
		const shell = resolvePreflightShell();
		const steps = planUpdateSteps({ piBin: resolvePi(), gitBash: shell });
		if (steps.length === 0) return undefined;
		// GUI 应用版本只用于摘要行,和更新步骤并行读(实测串行时白等 1.1s)
		versionsPromise = readAppVersions({ shell });
		const dsh = await planDshCliSteps(options.runner ?? execRunner, isInstalled("npm"), shell);
		steps.push(...dsh.steps);
		const say = options.onProgress ?? ((message: string) => process.stdout.write("[ais] " + message + "\n"));
		say("执行 " + steps.length + " 项更新…");
		const result = await (options.runPreflight ?? preflight)({
			steps,
			onProgress: say,
			onStepDone: ({ label, ok, ms, detail }) =>
				say(ok ? `${label} 完成(${formatDuration(ms)})` : `${label} 失败(${formatDuration(ms)})${detail ? ": " + detail : ""}`),
		});
		const failed = result.steps.filter((step) => !step.ok);
		// 只在全部成功时记时间:任何一步失败都不写,下次启动立刻重试
		if (failed.length === 0) writePreflightState(statePath);
		const versions = await versionsPromise;
		return "[ais] 启动前自更新: " + result.summary + (failed.length ? "" : "(全部成功)") + ";" + appVersionSummary(versions, dsh.status);
	} catch (error) {
		// 版本读取可能还在飞:吞掉它的拒绝,免得变成未处理拒绝
		await versionsPromise?.catch(() => undefined);
		return "[ais] 自更新跳过(" + (error instanceof Error ? error.message : String(error)) + ")";
	}
}
