/**
 * 自更新的"步骤怎么排":哪些命令、哪些跳过、怎么分组并行。
 * 与执行逻辑(preflight-run.ts)拆开,是为了守住单文件 200 行上限,也让"排步骤"可单测。
 */

import { planDshCliStep, type DshCliStatus } from "./apps.ts";
import { isInstalled, resolvePreflightShell } from "./preflight-env.ts";
import type { Step } from "./preflight.ts";

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

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * pi 本体由谁来更新。
 *
 * 不让 pi 自己更新自己(2026-10-08 实测事故):`pi update` 是在 **pi 运行中**执行
 * `pnpm install -g` 去替换 pi 自己所在的那棵依赖树,而树里有原生模块
 * (`@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/*.node`)。Windows 上被运行中
 * 进程加载的 .node 删不掉、换不掉,替换失败后 pnpm 已经把全局链接指向临时目录 ——
 * 结果是悬空链接 + 空注册表,之后每次启动都报 MODULE_NOT_FOUND,而失败当时毫无征兆
 * (那次是 0.85.1 → 1.1.0 的真跨版本更新;版本没变时 `pi update` 不装任何东西,所以以前从没暴露)。
 *
 * 由 shell 直接调包管理器,就没有 pi 进程参与替换。认不出装法时回落到 `pi update`:
 * 类 Unix 上替换运行中的文件本来就没问题,不受这个坑影响。
 *
 * 残留风险:替换期间若有**别的** pi 会话在跑,它的 .node 仍会挡住替换。所以紧随其后有一步
 * `校验 pi 可执行`,坏掉时当场说清怎么修。
 */
export function piUpdateCommand(piBin: string): string {
	const path = piBin.replace(/\\/g, "/").toLowerCase();
	if (path.includes("/pnpm/") || path.includes("/.pnpm/")) {
		// --config.minimumReleaseAge=0:pi 自己的更新器也带这个,否则 pnpm 的新版本冷静期会挡住刚发布的版本
		return `pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 ${PI_PACKAGE}@latest`;
	}
	if (path.includes("/npm/") || path.includes("/node_modules/")) {
		return `npm install -g --ignore-scripts --min-release-age=0 ${PI_PACKAGE}@latest`;
	}
	return `"${piBin}" update`;
}

/** 哪些步骤可以跳过(由 update-precheck.ts 的版本比对决定;未知一律不跳) */
export interface SkipFlags {
	pi?: boolean;
	extensions?: boolean;
	claude?: boolean;
}

/** 全部更新步骤(没有 Git Bash 时返回空,不做半套);skip 里的项按预检结论跳过 */
export function planUpdateSteps(input: { piBin: string; gitBash?: string; skip?: SkipFlags }): Step[] {
	const bash = input.gitBash;
	if (!bash) return [];
	const quoted = `"${input.piBin}"`;
	const skip = input.skip ?? {};
	// 分组:同一工具的两步保持先后顺序;不同工具并行(实测 4 步串行 11.7 秒 → 并行 ≈ 6 秒)
	const steps: Step[] = [];
	if (!skip.pi) {
		steps.push(bashStep("更新 pi 本体", bash, piUpdateCommand(input.piBin), { timeoutMs: 600_000, group: "pi" }));
		// 严格步骤:只在真的动过安装后校验(没装东西就没什么可坏);pi 起不来时当场失败,不写 TTL
		steps.push(bashStep("校验 pi 可执行", bash, `${quoted} --version`, { group: "pi" }));
	}
	if (!skip.extensions) steps.push(bashStep("更新 pi 扩展", bash, `${quoted} update --extensions`, { group: "pi" }));
	const others: [string, string, string, string][] = [
		["claude", "claude update", "更新 Claude Code", "claude"],
		["claude", "claude plugin update", "更新 Claude 插件", "claude"],
		["opencode", "opencode upgrade", "更新 opencode", "opencode"],
		["codex", "npm i -g @openai/codex@latest", "更新 codex", "npm"],
		["gemini", "npm i -g @google/gemini-cli@latest", "更新 gemini", "npm"],
	];
	for (const [bin, command, label, group] of others) {
		if (!isInstalled(bin)) continue;
		if (skip.claude && group === "claude" && label === "更新 Claude Code") continue;
		steps.push(bashStep(label, bash, command, { best: true, group }));
	}
	return steps; // 独立程序:不拉别人的仓库,也不跑别人的 setup.sh
}

/**
 * DSH 全局 CLI 的规划结果:要执行的步骤 + 摘要用的状态(0 或 1 个)。
 *
 * 用**文件系统**判定是否装了(与其它 CLI 同一套 isInstalled),不再跑 `npm ls -g` ——
 * 那条命令要 2 秒(实测),而它唯一的作用就是回答“装没装”,答案就在 PATH 上。
 */
export function planDshCliSteps(
	npmAvailable = isInstalled("npm"),
	shell: string | undefined = resolvePreflightShell(),
	hasCli = isInstalled("dsh"),
): { steps: Step[]; status: DshCliStatus } {
	if (!npmAvailable || !shell) return { steps: [], status: "npm-missing" };
	const step = planDshCliStep({ npmAvailable: true, hasGlobalCli: hasCli, shell });
	return step ? { steps: [step], status: "updated" } : { steps: [], status: "not-installed" };
}
