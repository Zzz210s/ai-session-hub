/**
 * 启动前自更新的环境探测:shell / pi 可执行文件 / 哪些 CLI 装了。
 * 从 preflight-run.ts 拆出(2026-10-05),让那边守住 200 行上限。
 *
 * Windows 的坑:`.cmd`/`.bat` 不能被 `execFile` 直接执行,裸 `bash` 又可能落到 WSL ——
 * 所以所有命令统一经 **Git Bash 绝对路径**执行,`.cmd` 路径用双引号包住。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";
export const PATH_SEP = IS_WINDOWS ? ";" : ":";

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

/** 毫秒 → "12.3s" / "820ms" */
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
