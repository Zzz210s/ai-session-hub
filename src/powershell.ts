/**
 * PowerShell 引擎解析 —— **唯一写者**。
 *
 * 为什么单独成模块:此前三处各写一份(`live/windows.ts` 的活体探测、`console-geometry.ts`
 * 的窗口尺寸、`recycle.ts` 的回收站),一处改了引擎另外两处不动 —— 2026-11-21 就是这样:
 * 探测换成了 pwsh,结果窗口尺寸探测还在用 powershell.exe,每次开新窗口白等 5-10 秒。
 *
 * 为什么默认 pwsh(2026-11-21 实测,同一份 scripts/windows.ps1,交替采样):
 *   powershell.exe  7087 / 12208 ms;连 `Write-Output hi` 都要 4.8-10 秒
 *   pwsh            1869-6205 ms(裸启动约 0.5 秒)
 * 差别几乎全在"每起一次 powershell.exe 被杀软扫一遍"的固定开销上。
 * 2026-11-19 曾测出"pwsh 更慢",那是 powershell.exe 启动只要 1.2 秒的时期 —— 固定开销小的时候
 * 比出来的是噪音。现在:有 pwsh 就用,找不到或坏掉自动退回 5.1(见 live/windows.ts 的重试)。
 */

import { existsSync } from "node:fs";

/** 找 pwsh:常见安装位置 → PATH */
export function findPwsh(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): string | undefined {
	const candidates = [
		`${env.ProgramFiles ?? "C:/Program Files"}/PowerShell/7/pwsh.exe`,
		`${env.LOCALAPPDATA ?? ""}/Microsoft/WindowsApps/pwsh.exe`,
		`${env.USERPROFILE ?? ""}/scoop/shims/pwsh.exe`,
	];
	for (const candidate of candidates) if (fileExists(candidate)) return candidate;
	for (const dir of (env.PATH ?? "").split(";")) {
		if (!dir) continue;
		const candidate = `${dir.replace(/[\\/]$/, "")}/pwsh.exe`;
		if (fileExists(candidate)) return candidate;
	}
	return undefined;
}

/**
 * 选 PowerShell 引擎:
 *   `AIS_PWSH=<路径>`  用指定引擎
 *   `AIS_PWSH=0`       强制系统自带 Windows PowerShell 5.1(排障用)
 *   默认               有 pwsh 就用 pwsh,否则 5.1
 */
export function resolvePowerShellEngine(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): string {
	const override = (env.AIS_PWSH ?? "").trim();
	if (override && !/^(auto|default)$/i.test(override)) {
		if (/^(0|false|off|no)$/i.test(override)) return "powershell.exe";
		return override;
	}
	return findPwsh(env, fileExists) ?? "powershell.exe";
}
