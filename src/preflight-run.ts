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
 * 细节与旧决策的关系见 preflight-ttl.ts。任何一步失败都不写时间戳,所以下次启动会立刻重试。
 *
 * 用户要求(2026-10-12):"修复 ais 启动过慢" —— TTL 过期后一次完整自更新已涨到 **37.5s**
 * (2026-10-08 把 pi 自更新从 `pi update` 换成 `pnpm install -g`,实测 9-28s;claude 侧 6.6s)。
 * 于是加了 **版本预检**(update-precheck.ts):先花约 2-4 秒查"本地版本 vs registry latest",
 * 已是最新的工具直接跳过对应命令 —— 实测全绿时 37.5s -> 约 4-6s。预检**失败即更新**,
 * 不会因为检测失效而漏更新;`AIS_UPDATE_PRECHECK=0` 可关闭。
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

import { appVersionSummary, readAppVersions } from "./apps.ts";
import { formatDuration, isInstalled, resolvePi, resolvePreflightShell } from "./preflight-env.ts";
import { planDshCliSteps, planUpdateSteps, piUpdateCommand, type SkipFlags } from "./preflight-plan.ts";
import { parseTtl, readPreflightState, skipReason, stateFilePath, writePreflightState } from "./preflight-ttl.ts";
import { execRunner, preflight, type Runner, type Step } from "./preflight.ts";
import { precheckEnabled, precheckUpdates, stillOutdated, type OutdatedRef, type PrecheckResult } from "./update-precheck.ts";

// 兼容既有导入路径(测试与 cli 都从本模块取这些)
export { formatDuration, isInstalled, resolveGitBash, resolvePi, resolvePreflightShell } from "./preflight-env.ts";
export { planDshCliSteps, planUpdateSteps, piUpdateCommand } from "./preflight-plan.ts";
export type { SkipFlags } from "./preflight-plan.ts";

/** 复核连续失败多少次后认账(避免一个永远升不上去的扩展让每次启动都白跑) */
const MAX_VERIFY_ATTEMPTS = 3;

export interface StartOptions {
	disabled?: boolean;
	onProgress?: (message: string) => void;
	/** 执行更新命令的 runner(测试注入,默认真跑) */
	runner?: Runner;
	/** preflight 实现(测试注入,默认真跑) */
	runPreflight?: typeof preflight;
	/** 读 GUI 应用版本(测试注入,默认真跑:Git Bash + PowerShell 约 3 秒) */
	readVersions?: typeof readAppVersions;
	/** 预检用的路径与 fetch(测试注入) */
	settingsPath?: string;
	extensionsRoot?: string;
	manifestPath?: string;
	fetchImpl?: typeof fetch;
}

/**
 * 跑一次版本预检:读本地 pi 版本(`pi --version`)+ 并行查 registry latest。
 * 任何异常都退回 unknown(照旧更新),不影响启动。
 *
 * pi 的版本必须**经 Git Bash** 读:pi 是 `.cmd` 包装器,`execFile` 直跑会
 * `spawn EINVAL`(2026-10-12 实测),那样预检永远拿不到 pi 版本 —— 表现为"pi 本体每次都更新",
 * 而它恰好是最慢的一步(pnpm install -g,实测 9-168 秒)。类 Unix 上直接用 `pi` 即可。
 */
async function runPrecheck(options: StartOptions, runner: Runner, piBin: string, shell?: string): Promise<PrecheckResult | undefined> {
	const readPiVersion = async (): Promise<string | undefined> => {
		const parse = (out: string) => /\d+\.\d+\.\d+[-+\w.]*/.exec(out)?.[0];
		if (shell) {
			const viaShell = await runner(shell, ["-lc", `"${piBin}" --version`], 60_000);
			if (viaShell.ok) return parse(viaShell.out);
		}
		const direct = await runner(piBin, ["--version"], 60_000);
		return direct.ok ? parse(direct.out) : undefined;
	};
	try {
		return await precheckUpdates({
			piVersion: readPiVersion,
			settingsPath: options.settingsPath,
			extensionsRoot: options.extensionsRoot,
			manifestPath: options.manifestPath,
			fetchImpl: options.fetchImpl,
		});
	} catch {
		return undefined;
	}
}

/** 更新跑完后按同一批来源重读版本,列出仍然落后的扩展(没跑更新步骤时返回空) */
async function verifyExtensionUpdates(pre: PrecheckResult | undefined, steps: Step[]): Promise<OutdatedRef[]> {
	if (!pre?.latest || !pre.sources) return [];
	if (!steps.some((step) => step.label === "更新 pi 扩展")) return [];
	try {
		return stillOutdated(pre.sources, pre.latest);
	} catch {
		return []; // 复核自己出错不该把一次成功的更新判成失败
	}
}

/**
 * 启动前自更新:TTL 内跳过;过期则先做版本预检,只跑真的需要跑的更新命令;返回一行摘要(失败不抛)。
 */
export async function startPreflight(options: StartOptions = {}): Promise<string | undefined> {
	let versionsPromise: Promise<Record<string, string>> | undefined;
	try {
		if (options.disabled || process.env.AIS_NO_UPDATE === "1") return undefined;
		const statePath = stateFilePath();
		const ttlSkip = skipReason(readPreflightState(statePath), Date.now(), parseTtl(process.env.AIS_UPDATE_TTL));
		if (ttlSkip) return "[ais] 启动前自更新: " + ttlSkip;
		const shell = resolvePreflightShell();
		const runner = options.runner ?? execRunner;
		const piBin = resolvePi();
		// 版本预检(2026-10-12):查一次 registry,已是最新的工具就跳过对应更新命令。
		// 实测全绿时整段自更新 37.5s -> 约 4-6s;任何不确定都退回"照旧更新"。
		const pre = precheckEnabled() ? await runPrecheck(options, runner, piBin, shell) : undefined;
		const skip: SkipFlags = { pi: pre?.pi === "up-to-date", extensions: pre?.extensions === "up-to-date", claude: pre?.claude === "up-to-date" };
		const steps = planUpdateSteps({ piBin, gitBash: shell, skip });
		// GUI 应用版本只用于摘要行,和更新步骤并行读(实测串行时白等 1.1s)
		versionsPromise = (options.readVersions ?? readAppVersions)({ shell });
		const dsh = planDshCliSteps(isInstalled("npm"), shell);
		steps.push(...dsh.steps);
		const say = options.onProgress ?? ((message: string) => process.stdout.write("[ais] " + message + "\n"));
		// 受管清单里"只在清单、不在 settings"的扩展:pi 永远不会更新它们,提示一次总比永远不知道好
		const orphanNote = pre?.orphans?.length
			? ";清单里有不会被 pi 更新的扩展: " + pre.orphans.map((ref) => `${ref.name} ${ref.installed ?? "?"}→${ref.target ?? "?"}`).join(", ")
			: "";
		const prefix = (pre?.note ? ";" + pre.note : "") + orphanNote;
		if (steps.length === 0) {
			// 没步骤可跑:环境不支持(没有 Git Bash)时静默;预检说"已是最新"时记时间并报告
			if (!pre?.note) return undefined;
			writePreflightState(statePath, Date.now(), 0);
			const versions = await versionsPromise;
			return "[ais] 启动前自更新: 无需执行" + prefix + ";" + appVersionSummary(versions, dsh.status);
		}
		say("执行 " + steps.length + " 项更新…");
		const result = await (options.runPreflight ?? preflight)({
			steps,
			onProgress: say,
			onStepDone: ({ label, ok, ms, detail }) =>
				say(ok ? `${label} 完成(${formatDuration(ms)})` : `${label} 失败(${formatDuration(ms)})${detail ? ": " + detail : ""}`),
		});
		const failed = result.steps.filter((step) => !step.ok);
		// 更新后复核:pi update --extensions 有"装了旧版本却不报错"的已知路径(npm 解析到过期元数据),
		// 退出码仍是 0。不复核就会把这种"不完全更新"记成成功并写 TTL,接下来 6 小时都不再试。
		const behind = await verifyExtensionUpdates(pre, steps);
		// 只在全部成功时记时间:任何一步失败(或复核发现仍落后)都不写,下次启动立刻重试。
		// 复核连续失败到上限就认账写时间戳 —— 否则一个"永远升不上去"的扩展会让每次启动都白跑十几秒。
		const previousFailures = readPreflightState(statePath).verifyFailures ?? 0;
		let retryNote = "";
		if (failed.length === 0 && behind.length === 0) {
			writePreflightState(statePath, Date.now(), 0);
		} else if (failed.length === 0 && behind.length > 0) {
			const attempts = previousFailures + 1;
			if (attempts >= MAX_VERIFY_ATTEMPTS) {
				writePreflightState(statePath, Date.now(), attempts);
				retryNote = `(连续 ${attempts} 次没生效,先按已更新处理;设 AIS_UPDATE_TTL=0 可强制重试)`;
			} else {
				writePreflightState(statePath, undefined, attempts);
				retryNote = `(第 ${attempts}/${MAX_VERIFY_ATTEMPTS} 次,下次启动重试)`;
			}
		}
		const behindNote = behind.length
			? `;pi 扩展仍未更新: ${behind.map((ref) => `${ref.name} ${ref.installed ?? "?"}→${ref.target ?? "?"}`).join(", ")}${retryNote}`
			: "";
		const versions = await versionsPromise;
		// pi 本体坏了要立刻说清怎么修:症状是启动时一屏 MODULE_NOT_FOUND,光看堆栈无从下手
		const repair = failed.some((step) => step.label === "校验 pi 可执行")
			? ";pi 本体起不来,修复:" + piUpdateCommand(resolvePi()) + " 然后重跑 config-ai/setup.sh"
			: "";
		const allOk = failed.length === 0 && behind.length === 0;
		return "[ais] 启动前自更新: " + result.summary + (allOk ? "(全部成功)" : "") + prefix + ";" + appVersionSummary(versions, dsh.status) + repair + behindNote;
	} catch (error) {
		// 版本读取可能还在飞:吞掉它的拒绝,免得变成未处理拒绝
		await versionsPromise?.catch(() => undefined);
		return "[ais] 自更新跳过(" + (error instanceof Error ? error.message : String(error)) + ")";
	}
}
