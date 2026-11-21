/**
 * 送入系统回收站(而非硬删除),并让用户能在文件管理器里还原。
 *
 * Windows:scripts/recycle.ps1(VisualBasic.FileIO + SendToRecycleBin)
 * Linux:按 freedesktop.org 规范写 ~/.local/share/Trash/{files,info}
 *   - files/<名字> 放文件本身;info/<名字>.trashinfo 记录原始路径与删除时间
 *   - 同名冲突时加 .1 .2 后缀(与规范一致)
 * 其它平台或失败时返回 ok:false,调用方退回内部回收目录。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePowerShellEngine } from "./powershell.ts";
import { fileURLToPath } from "node:url";

// Linux 的 freedesktop 回收站实现在 recycle-linux.ts;这里再导出,调用方不用改导入路径
export { encodeTrashPath, pathExists, pickTrashName, recycleToTrashLinux, trashRoot } from "./recycle-linux.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "recycle.ps1");

export interface RecycleResult {
	ok: boolean;
	detail?: string;
	/** 解释器不存在(内部用:退回 Windows PowerShell) */
	missingShell?: boolean;
}

/** 是否具备"系统回收站"能力 */
export function canRecycleToSystem(): boolean {
	if (process.platform === "win32") return existsSync(SCRIPT);
	if (process.platform === "linux") return existsSync("/proc/self/status");
	return false;
}

/**
 * 选一个 PowerShell 来解释 recycle.ps1 —— 直接复用共享解析器(src/powershell.ts),
 * 不在这里再写一份候选列表:三处各写一份的结果就是改了一处、另两处还在用慢引擎
 * (2026-11-21 实测 powershell.exe 启动 5-10 秒,pwsh 0.5 秒)。
 */
export function resolveRecycleShell(env: NodeJS.ProcessEnv = process.env, fileExists: (p: string) => boolean = existsSync): string {
	return resolvePowerShellEngine(env, fileExists);
}

/**
 * 解析 recycle.ps1 的输出(每个路径一行,制表符分隔)。
 *
 * 兼容老格式:单路径时的 `RECYCLED` / `FAIL <原因>` 也算。
 * 没有报告的路径一律算失败 —— 不能把"没回话"当成功(那会让会话既没删掉又显示已删除)。
 */
export function parseRecycleReport(stdout: string, paths: string[]): Map<string, RecycleResult> {
	const out = new Map<string, RecycleResult>();
	const lines = stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
	const single = paths.length === 1 ? paths[0] : undefined;
	for (const line of lines) {
		// 新格式:制表符分隔(路径里可以有空格)
		const parts = line.split("\t");
		const verb = parts[0] ?? "";
		if (verb === "RECYCLED") {
			const target = parts[1] ?? single;
			if (target) out.set(target, { ok: true });
			continue;
		}
		if (verb === "FAIL") {
			const target = parts.length > 2 ? parts[1] : single;
			const detail = parts.length > 2 ? parts.slice(2).join(" ") : parts.slice(1).join(" ");
			if (target) out.set(target, { ok: false, detail: detail.trim() || "回收站调用失败" });
			continue;
		}
		// 老格式:单路径时的 `RECYCLED` / `FAIL <原因>`
		if (line === "RECYCLED" && single) {
			out.set(single, { ok: true });
			continue;
		}
		if (line.startsWith("FAIL ") && single) {
			out.set(single, { ok: false, detail: line.slice(5).trim() || "回收站调用失败" });
		}
	}
	for (const path of paths) {
		if (!out.has(path)) out.set(path, { ok: false, detail: "回收站没有回话(可能被安全软件拦下)" });
	}
	return out;
}

/**
 * 批量送系统回收站:**一次**进程启动处理所有路径。
 *
 * 一次 PowerShell 启动约 750ms(杀软扫 exe),而 DSH 会话要移走会话目录 + 元数据两条路径,
 * 逐个起进程就把删除耗时乘上了路径数。返回按路径归位的结果,失败的路径由调用方退回内部回收目录。
 */
export function recycleManyToSystem(paths: string[]): Promise<Map<string, RecycleResult>> {
	if (paths.length === 0) return Promise.resolve(new Map());
	if (process.platform === "linux") {
		const out = new Map<string, RecycleResult>();
		for (const path of paths) out.set(path, recycleToTrashLinux(path));
		return Promise.resolve(out);
	}
	if (process.platform !== "win32") {
		const out = new Map<string, RecycleResult>();
		for (const path of paths) out.set(path, { ok: false, detail: "当前平台没有系统回收站" });
		return Promise.resolve(out);
	}
	if (!existsSync(SCRIPT)) {
		const out = new Map<string, RecycleResult>();
		for (const path of paths) out.set(path, { ok: false, detail: "缺少 scripts/recycle.ps1" });
		return Promise.resolve(out);
	}
	// 路径清单走临时文件:PowerShell 的 [string[]] 只认 `-Path a,b` 一元写法,`-Path a b` 会报
	// "A positional parameter cannot be found",而路径里可能带逗号 —— 清单文件两种毛病都没有
	const listFile = join(tmpdir(), `ais-recycle-${randomUUID()}.txt`);
	const done = (): void => {
		void rm(listFile, { force: true }).catch(() => undefined);
	};
	try {
		// 带 BOM 的 UTF-8:PowerShell 5.1 读 BOM-less 中文清单会乱码
		writeFileSync(listFile, "\ufeff" + paths.join("\n") + "\n", "utf8");
	} catch (error) {
		const out = new Map<string, RecycleResult>();
		for (const path of paths) out.set(path, { ok: false, detail: `无法写路径清单: ${error instanceof Error ? error.message : String(error)}` });
		return Promise.resolve(out);
	}
	const attempt = (shell: string): Promise<{ report: Map<string, RecycleResult>; missingShell: boolean }> =>
		new Promise((resolve) => {
			execFile(
				shell,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-ListFile", listFile],
				{ windowsHide: true, timeout: 20_000 },
				(error, stdout, stderr) => {
					const text = (stdout ?? "").trim();
					const report = parseRecycleReport(text, paths);
					if (text.length === 0) {
						// 一行都没有:把进程层错误说清楚(路径/权限/超时),否则只会显示"没有回话"
						const detail = stderr?.trim() || error?.message || "回收站调用失败";
						for (const path of paths) report.set(path, { ok: false, detail });
					}
					resolve({ report, missingShell: error?.code === "ENOENT" });
				},
			);
		});
	const shell = resolveRecycleShell();
	return attempt(shell)
		.then((first) =>
			// pwsh 没装(ENOENT)时退回 Windows PowerShell 5.1 —— 慢,但能用
			first.missingShell && shell !== "powershell.exe" ? attempt("powershell.exe").then((second) => second.report) : first.report,
		)
		.finally(done);
}

export function recycleToSystem(path: string): Promise<RecycleResult> {
	return recycleManyToSystem([path]).then((report) => report.get(path) ?? { ok: false, detail: "回收站调用失败" });
}
