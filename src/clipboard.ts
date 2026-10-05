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
 * 把文本写给剪贴板命令的 stdin,等 stdin 与子进程两边都落定再回结果。
 *
 * 为什么必须挂 stdin 的 error 监听:子进程提前退出(没读完输入)时,写入 stdin 会
 * emit EOF/EPIPE。没有监听就是 uncaught exception,而 execFile 回调还可能报成功 ——
 * 会出现"提示已复制、其实没复制"。这里把这类错误一律按失败返回。
 */
export function writeClipboard(text: string, clip: string, args: string[]): Promise<ActionResult> {
	return new Promise<ActionResult>((resolve) => {
		let childDone = false;
		let stdinDone = false;
		let childError: unknown = null;
		let stdinError: Error | null = null;
		const finish = (): void => {
			if (!childDone || !stdinDone) return;
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
		const child = execFile(clip, args, (error) => {
			childDone = true;
			childError = error ?? null;
			finish();
		});
		if (!child.stdin) {
			stdinDone = true;
			finish();
			return;
		}
		child.stdin.on("error", (error) => {
			stdinError = error;
			stdinDone = true;
			finish();
		});
		child.stdin.on("finish", () => {
			stdinDone = true;
			finish();
		});
		child.stdin.end(text);
	});
}

/** 把文本写进系统剪贴板(行为与文案不变;真正的写入与错误处理见 writeClipboard) */
export function copyToClipboard(text: string): ActionResult {
	const { clip, args } = clipboardCommand();
	return writeClipboard(text, clip, args) as unknown as ActionResult;
}
