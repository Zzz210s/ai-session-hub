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

/** 从 Windows 卸载项列表里认出这两个应用(纯函数,便于单测) */
export function parseUninstallVersions(entries: unknown): AppVersions {
	const list = Array.isArray(entries) ? entries : [];
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

/** 人类可读的一行摘要(缺版本时明说未检测到) */
export function appVersionSummary(versions: AppVersions): string {
	const parts = [versions.zed ? `Zed ${versions.zed}` : "", versions.dsh ? `DeepSeek Harness ${versions.dsh}` : ""].filter(Boolean);
	if (parts.length === 0) return "未检测到 Zed / DeepSeek Harness(GUI 应用自更新,ais 不代管)";
	return `${parts.join(" / ")}(GUI 应用自更新,ais 不代管)`;
}

/** DSH 全局 CLI 的更新步骤;没装 npm 或没装全局 CLI 就返回 undefined(不排步骤) */
export function planDshCliStep(input: { npmAvailable: boolean; hasGlobalCli: boolean; timeoutMs?: number }): Step | undefined {
	if (!input.npmAvailable || !input.hasGlobalCli) return undefined;
	return {
		label: "更新 DSH CLI",
		command: "npm",
		args: ["i", "-g", "@deepseek-ai/dsh@latest"],
		timeoutMs: input.timeoutMs ?? 180_000,
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
		? await run(input.shell, ["-lc", "npm ls -g --depth=0 @deepseek-ai/dsh 2>&1 || true"], 60_000)
		: await run("npm", ["ls", "-g", "--depth=0", "@deepseek-ai/dsh"], 60_000);
	return ok && out.includes("@deepseek-ai/dsh");
}
