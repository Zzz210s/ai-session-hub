/**
 * 剪贴板写入(独立成文件:actions.ts 已接近 200 行上限,且这里只依赖 execFile)。
 * 保持返回文案与原先一致("已复制: …"),既有调用方与测试无需改动。
 */

import { execFile } from "node:child_process";
import type { ActionResult } from "./actions.ts";

/** 选系统剪贴板命令(Windows: clip.exe;Linux: Wayland 优先 wl-copy,否则 xclip) */
export function clipboardCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): { clip: string; args: string[] } {
	if (platform === "win32") return { clip: "clip.exe", args: [] };
	const clip = env.WAYLAND_DISPLAY ? "wl-copy" : env.DISPLAY ? "xclip" : "wl-copy";
	return { clip, args: clip === "xclip" ? ["-selection", "clipboard"] : [] };
}

/**
 * 把文本写给剪贴板命令的 stdin,等 execFile 回调落定后回结果。
 *
 * 只在 execFile 回调里 resolve:子进程启动失败(ENOENT)与正常结束都会走到回调,
 * 而 spawn 失败时 stdin 只 emit "close"(既无 error 也无 finish),若把 stdin 的
 * 完成也当门闩就会永久挂起。
 *
 * stdin 的 error 监听仍然保留:子进程提前退出(没读完输入)时写入 stdin 会 emit
 * EPIPE,而 execFile 回调可能报成功 —— 会出现"提示已复制、其实没复制"。这类错误
 * 只用来覆盖失败文案(记录 fmt 到 stdinError),错误与否仍以回调为准。
 *
 * timeout 兜住"子进程既不读 stdin 也不退出"的死角:超时由 execFile 杀进程并回调。
 */
export function writeClipboard(
	text: string,
	clip: string,
	args: string[],
	timeoutMs = 5000,
): Promise<ActionResult> {
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
					? { ok: false, detail: `复制失败(${clip}):${message}\n可手动复制:${text}` }
					: { ok: true, detail: `已复制: ${text}` },
			);
		};
		const child = execFile(clip, args, { timeout: timeoutMs }, (error) => {
			finish(error ?? null);
		});
		if (!child.stdin) {
			finish(null);
			return;
		}
		child.stdin.on("error", (error) => {
			stdinError = error;
		});
		child.stdin.end(text);
	});
}

/** 把文本写进系统剪贴板(行为与文案不变;真正的写入与错误处理见 writeClipboard) */
export function copyToClipboard(text: string): ActionResult {
	const { clip, args } = clipboardCommand();
	return writeClipboard(text, clip, args) as unknown as ActionResult;
}
