/**
 * Shell 适配层:让"接管终端 / 分屏面板 / 新标签恢复"在各平台都能工作。
 *
 * Windows:AIS_SHELL 指定 > 自动探测(Git Bash 优先,其次 PowerShell,最后 cmd)
 * Linux/macOS:$SHELL > /bin/bash > /bin/sh(POSIX 家族,统一走 -lc)
 * 每种 shell 的启动参数不同:
 *   bash/POSIX -lc "<command>"(命令结束后可 exec 保持交互)
 *   powershell -NoLogo -NoProfile -Command "<command>"(保持交互用 -NoExit)
 *   cmd        /d /s /c "<command>"
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type ShellFlavor = "bash" | "powershell" | "cmd";

/** 由可执行文件路径判断 shell 类型(纯函数) */
export function shellFlavor(shellPath: string): ShellFlavor {
	const lower = shellPath.toLowerCase().replace(/\\/g, "/");
	if (lower.includes("powershell") || lower.endsWith("/pwsh") || lower.endsWith("/pwsh.exe")) return "powershell";
	if (/(^|\/)(ba|z|da|k|fi)?sh(\.exe)?$/.test(lower) || lower.includes("bash") || lower.includes("sh.exe")) return "bash";
	return "cmd";
}

function candidates(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") {
		return [env.SHELL ?? "", "/bin/bash", "/usr/bin/bash", "/bin/sh"].filter((candidate) => candidate.length > 0);
	}
	const programFiles = env.ProgramFiles ?? "C:\\Program Files";
	const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const systemRoot = env.SystemRoot ?? "C:\\Windows";
	return [
		join(programFiles, "Git", "bin", "bash.exe"),
		join(programFilesX86, "Git", "bin", "bash.exe"),
		// PowerShell 7 优先于 Windows PowerShell 5.1
		join(programFiles, "PowerShell", "7", "pwsh.exe"),
		join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
	];
}

/**
 * 解析要使用的 shell:显式指定优先,否则按候选顺序挑第一个存在的
 * (exists 可注入,便于单测)
 */
export function resolveShell(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
	const explicit = (env.AIS_SHELL ?? "").trim();
	if (explicit) return explicit;
	const found = candidates(env).find((candidate) => exists(candidate));
	if (found) return found;
	const list = candidates(env);
	return list[list.length - 1] ?? "/bin/sh";
}

export interface ShellArgs {
	/** 执行一条命令所需的参数 */
	command: string[];
	/** 进入交互式 shell 所需参数 */
	interactive: string[];
}

/**
 * 生成启动参数(纯函数)。
 * keepAlive:命令结束后保持交互(分屏面板用),不传则退出。
 */
export function shellArgs(shellPath: string, command: string, options: { keepAlive?: boolean } = {}): ShellArgs {
	const flavor = shellFlavor(shellPath);
	if (flavor === "powershell") {
		const args = ["-NoLogo", "-NoProfile"];
		if (options.keepAlive) args.push("-NoExit");
		args.push("-Command", command);
		return { command: args, interactive: ["-NoLogo", "-NoProfile"] };
	}
	if (flavor === "cmd") {
		return { command: ["/d", "/s", "/c", command], interactive: [] };
	}
	// bash
	return {
		command: options.keepAlive ? ["-lc", `${command}; exec "$BASH" || exec bash`] : ["-lc", command],
		interactive: ["-l"],
	};
}

/**
 * 供展示:命令在用户 shell 里的等价写法。
 * 判定完全基于路径(与运行平台无关),这样同一个路径在任何机器上展示一致、也好测:
 * Git for Windows 的 bash 才叫 "Git Bash",其它类 Unix shell 直接报可执行文件名。
 */
export function shellPromptLabel(shellPath: string): string {
	const flavor = shellFlavor(shellPath);
	if (flavor === "powershell") return "PowerShell";
	if (flavor === "cmd") return "cmd";
	if (/git[\\/](usr[\\/])?bin[\\/]bash\.exe$/i.test(shellPath)) return "Git Bash";
	return shellPath.split(/[\/]/).pop() || "bash";
}
