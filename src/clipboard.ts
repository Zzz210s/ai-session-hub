/**
 * 剪贴板写入(独立成文件:actions.ts 已接近 200 行上限,且这里只依赖 execFile)。
 * 保持返回文案与原先一致("已复制: …"),既有调用方与测试无需改动。
 *
 * Windows 不能把文本直接写进 clip.exe:它按当前控制台代码页(中文机器 CP936)解码
 * stdin,而这里写的是 UTF-8 字节,非 ASCII 一律乱码(会话标题、中文项目路径必中)。
 * 因此 Windows 改走 PowerShell:文本先 base64,脚本里由 .NET 按 UTF-8 解码再
 * Set-Clipboard,全程不经过代码页。Linux 的 wl-copy/xclip 本就按 UTF-8 处理,不变。
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActionResult } from "./actions.ts";

/** 一条写入计划:命令、参数、要写进 stdin 的文本,以及缺命令时的退路 */
export interface ClipboardPlan {
	/** 系统剪贴板命令 */
	clip: string;
	args: string[];
	/** 写进子进程 stdin 的文本(Windows 把文本编进命令行参数,故为空串) */
	stdin: string;
	/** 原始文本(仅用于失败提示里的「可手动复制」) */
	text: string;
	/** 命令不存在(spawn ENOENT)时的退路:Windows 退回 clip.exe */
	fallback?: ClipboardPlan;
	/** 临时文件的 Node 侧清理(与脚本里的 Remove-Item 双保险;失败路径也由调用方 finally 触发) */
	cleanup?: () => void;
}

/** 可注入的副作用(测试用来构造写文件失败的路径) */
export interface ClipboardDeps {
	/** 超长文本落临时文件的写实现,默认 writeFileSync */
	writeTemp?: (path: string, text: string) => void;
}

function defaultWriteTemp(path: string, text: string): void {
	writeFileSync(path, text, { encoding: "utf8" });
}

/** Windows 命令行上限约 32767;base64 膨胀 4/3,超过此长度改用 UTF-8 临时文件 */
const MAX_INLINE_CHARS = 4000;

const PS = "powershell.exe";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

/** System32 下的 Windows PowerShell;不在标准位置就交给 PATH 解析 */
function powershellPath(env: NodeJS.ProcessEnv): string {
	const root = env.SystemRoot ?? env.windir;
	if (!root) return PS;
	const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return existsSync(full) ? full : PS;
}

/** 退路:clip.exe 直接吃 stdin(非 ASCII 会按 CP936 解成乱码,只在 PowerShell 缺失时用) */
function clipExePlan(text: string): ClipboardPlan {
	return { clip: "clip.exe", args: [], stdin: text, text };
}

/** PowerShell 写剪贴板:短文本 base64 内联,超长文本落 UTF-8 文件由脚本读回并删除 */
function windowsPlan(text: string, env: NodeJS.ProcessEnv, deps: ClipboardDeps = {}): ClipboardPlan {
	const clip = powershellPath(env);
	let script: string;
	if (text.length <= MAX_INLINE_CHARS) {
		const b64 = Buffer.from(text, "utf8").toString("base64");
		// 空串会让 Set-Clipboard 抛 ArgumentNullException(值不能为 null),改用 $null 清空
		script = `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));if($t.Length -eq 0){$t=$null};Set-Clipboard -Value $t`;
	} else {
		// 随机后缀:同毫秒内多次复制不会互相覆盖
		const path = join(tmpdir(), `ais-clipboard-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.txt`);
		(deps.writeTemp ?? defaultWriteTemp)(path, text);
		const literal = path.replace(/'/g, "''");
		script =
			`$t=[IO.File]::ReadAllText('${literal}',[Text.Encoding]::UTF8);Set-Clipboard -Value $t;` +
			`Remove-Item -LiteralPath '${literal}' -Force -ErrorAction SilentlyContinue`;
		// Node 侧兜底:脚本没跑到(超时被杀 / Set-Clipboard 抛错 / spawn 前崩溃)也要删掉
		const cleanup = (): void => {
			try {
				unlinkSync(path);
			} catch {
				/* 已删或不可删,忽略 */
			}
		};
		return { clip, args: [...PS_ARGS, script], stdin: "", text, fallback: clipExePlan(text), cleanup };
	}
	return { clip, args: [...PS_ARGS, script], stdin: "", text, fallback: clipExePlan(text) };
}

/** 选命令并把文本编成该命令能无损接住的形态(可注入 env/platform 便于单测) */
export function clipboardPlan(
	text: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	deps: ClipboardDeps = {},
): ClipboardPlan {
	if (platform === "win32") return windowsPlan(text, env, deps);
	const clip = env.WAYLAND_DISPLAY ? "wl-copy" : env.DISPLAY ? "xclip" : "wl-copy";
	return { clip, args: clip === "xclip" ? ["-selection", "clipboard"] : [], stdin: text, text };
}

/**
 * 执行一条写入计划,等 execFile 回调落定后回结果。
 *
 * 只在 execFile 回调里 resolve:子进程启动失败(ENOENT)与正常结束都会走到回调,
 * 而 spawn 失败时 stdin 只 emit "close"(既无 error 也无 finish),若把 stdin 的
 * 完成也当门闩就会永久挂起。
 *
 * 子进程没有 stdin,或 stdin 提前关闭(子进程没读完输入 -> EPIPE),都不能报成功:
 * 那会出现"提示已复制、其实没复制"。stdin 的 error 只记录到 stdinError,用来覆盖
 * 回调那侧的成功文案;错误与否仍以回调为准。
 *
 * timeout 兜住"子进程既不读 stdin 也不退出"的死角:超时由 execFile 杀进程并回调。
 */
export function writeClipboard(plan: ClipboardPlan, timeoutMs = 5000): Promise<ActionResult> {
	return new Promise<ActionResult>((resolve) => {
		let settled = false;
		let stdinError: Error | null = null;
		const finish = (childError: unknown): void => {
			if (settled) return;
			settled = true;
			let message = "";
			if (stdinError) message = stdinError.message;
			else if (childError) message = childError instanceof Error ? childError.message : String(childError);
			message = message.split("\n")[0];
			resolve(
				message
					? { ok: false, detail: `复制失败(${plan.clip}):${message}\n可手动复制:${plan.text}` }
					: { ok: true, detail: `已复制: ${plan.text}` },
			);
		};
		const child = execFile(plan.clip, plan.args, { timeout: timeoutMs }, (error) => {
			finish(error ?? null);
		});
		if (!child.stdin) {
			finish(new Error("子进程没有 stdin,无法写入文本"));
			return;
		}
		child.stdin.on("error", (error) => {
			stdinError = error;
		});
		child.stdin.end(plan.stdin);
	});
}

/**
 * 执行计划;命令缺失(ENOENT)时按 fallback 重试一次,回退成功要如实说明。
 * 无论成功失败都在 finally 里删临时文件(Node 侧保证清理)。
 * ENOENT 只认失败描述的首行:detail 末尾会附"可手动复制:<用户文本>",
 * 用户文本里恰好含 ENOENT 时不能误触发 clip.exe 回退。
 */
export async function runClipboardPlan(plan: ClipboardPlan): Promise<ActionResult> {
	try {
		const result = await writeClipboard(plan);
		const failureLine = result.detail.split("\n", 1)[0] ?? "";
		if (result.ok || !plan.fallback || !failureLine.includes("ENOENT")) return result;
		const alt = await writeClipboard(plan.fallback);
		if (!alt.ok) return result;
		return { ok: true, detail: `已复制(经 ${plan.fallback.clip} 回退,非 ASCII 可能乱码): ${plan.text}` };
	} finally {
		plan.cleanup?.();
		plan.fallback?.cleanup?.();
	}
}

/** copyToClipboard 的可选注入(测试用;默认走真实环境) */
export interface CopyOptions extends ClipboardDeps {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

/**
 * 把文本写进系统剪贴板(行为与文案不变;真正的编码与命令选择见 clipboardPlan)。
 * 任何同步异常(TEMP 不可写/磁盘满)都转成 {ok:false},不让异常逃到调用方。
 */
export async function copyToClipboard(text: string, options: CopyOptions = {}): Promise<ActionResult> {
	try {
		const plan = clipboardPlan(text, options.env ?? process.env, options.platform ?? process.platform, options);
		return await runClipboardPlan(plan);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `复制失败:${message}\n可手动复制:${text}` };
	}
}
