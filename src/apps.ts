/**
 * GUI AI 应用(Zed / DeepSeek Harness)的版本探测与更新步骤规划。
 *
 * 为什么只"探测 + 报告":两者都是自带更新器的桌面应用,ais 不代管它们的升级;
 * 唯一能真正更新的是 DSH 的**全局 CLI**(npm 包),而且只有确实装了才排步骤。
 *
 * 探测命令都经 POSIX shell 执行:Windows 上 execFile 不能直接跑 .cmd(ENOENT/EINVAL),
 * 与 preflight-run.ts 里其它步骤同一约定。shell 由调用方传入,便于离线单测注入假 runner。
 */

import { execRunner, type Runner, type Step } from "./preflight.ts";

export interface AppVersions {
	zed?: string;
	dsh?: string;
}

/** DSH 全局 CLI 在本次启动前的处置结果(用于摘要里说明是跳过还是更新) */
export type DshCliStatus = "updated" | "not-installed" | "npm-missing";

const DSH_CLI_LABEL: Record<DshCliStatus, string> = {
	updated: "已更新",
	"not-installed": "未安装,跳过",
	"npm-missing": "无 npm,跳过",
};

/** 从 Windows 卸载项列表里认出这两个应用(纯函数,便于单测;PowerShell 只回一项时是对象不是数组) */
export function parseUninstallVersions(entries: unknown): AppVersions {
	const list = Array.isArray(entries) ? entries : entries && typeof entries === "object" ? [entries] : [];
	const found: AppVersions = {};
	for (const raw of list) {
		const entry = raw as { DisplayName?: unknown; DisplayVersion?: unknown };
		const name = typeof entry.DisplayName === "string" ? entry.DisplayName : "";
		const version = typeof entry.DisplayVersion === "string" ? entry.DisplayVersion : undefined;
		if (!version) continue;
		if (/^Zed\b/i.test(name)) found.zed ??= version;
		else if (/DeepSeek Harness/i.test(name)) found.dsh ??= version;
	}
	return found;
}

/** 人类可读的一行摘要(缺版本时明说未检测到;带 DSH CLI 状态时明说跳过/更新) */
export function appVersionSummary(versions: AppVersions, dshCli?: DshCliStatus): string {
	const parts = [versions.zed ? `Zed ${versions.zed}` : "", versions.dsh ? `DeepSeek Harness ${versions.dsh}` : ""].filter(Boolean);
	const apps = parts.length === 0 ? "未检测到 Zed / DeepSeek Harness" : parts.join(" / ");
	const cli = dshCli ? `;DSH 全局 CLI:${DSH_CLI_LABEL[dshCli]}` : "";
	return `${apps}(GUI 应用自更新,ais 不代管${cli})`;
}

/**
 * DSH 全局 CLI 的更新步骤;没装 npm、没装全局 CLI 或没有 shell 就返回 undefined(不排步骤)。
 * 命令必须经 shell 包装(Windows 上 execFile 不能直接跑 .cmd,裸 npm 会 ENOENT/EINVAL),
 * 与 codex/gemini 两个 npm 步骤同一写法:尽力而为(失败不拦启动)、900s、归 npm 组。
 */
export function planDshCliStep(input: { npmAvailable: boolean; hasGlobalCli: boolean; shell?: string; timeoutMs?: number }): Step | undefined {
	if (!input.npmAvailable || !input.hasGlobalCli || !input.shell) return undefined;
	return {
		label: "更新 DSH CLI",
		command: input.shell,
		args: ["-lc", "npm i -g @deepseek-ai/dsh@latest >/dev/null 2>&1 || true"],
		timeoutMs: input.timeoutMs ?? 900_000,
		group: "npm",
	};
}

/** Windows:读 HKCU 卸载项;其它平台或拿不到 shell 时返回空对象(不猜) */
export async function readAppVersions(input: { shell?: string; runner?: Runner } = {}): Promise<AppVersions> {
	if (process.platform !== "win32") return {};
	if (!input.shell) return {};
	const script =
		"Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | " +
		"Select-Object DisplayName,DisplayVersion | ConvertTo-Json -Compress";
	const run = input.runner ?? execRunner;
	const { ok, out } = await run(input.shell, ["-lc", `powershell -NoProfile -NonInteractive -Command "${script}"`], 30_000);
	if (!ok) return {};
	try {
		return parseUninstallVersions(JSON.parse(out));
	} catch {
		return {};
	}
}

/** 全局 npm 里有没有 DSH CLI(只查一层);经 shell 跑 npm,兼容 Windows 的 .cmd */
export async function hasGlobalDshCli(input: { shell?: string; runner?: Runner } = {}): Promise<boolean> {
	const run = input.runner ?? execRunner;
	const { ok, out } = input.shell
		? await run(input.shell, ["-lc", "npm ls -g --depth=0 @deepseek-ai/dsh"], 60_000)
		: await run("npm", ["ls", "-g", "--depth=0", "@deepseek-ai/dsh"], 60_000);
	// 退出码 1 才是"未安装"的可靠信号(不抹掉);输出子串仅作辅助,防某版 npm 在错误文本里回显包名
	return ok && out.includes("@deepseek-ai/dsh");
}
