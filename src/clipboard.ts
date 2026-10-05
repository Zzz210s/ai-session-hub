/**
 * 剪贴板写入(独立成文件:actions.ts 已接近 200 行上限,且这里只依赖 execFile)。
 * 保持返回文案与原先一致("已复制: …"),既有调用方与测试无需改动。
 */

import { execFile } from "node:child_process";
import type { ActionResult } from "./actions.ts";

const IS_WINDOWS = process.platform === "win32";

/** 把文本写进系统剪贴板(Windows: clip.exe;Linux: wl-copy / xclip) */
export function copyToClipboard(text: string): ActionResult {
	const clip = IS_WINDOWS ? "clip.exe" : process.env.WAYLAND_DISPLAY ? "wl-copy" : process.env.DISPLAY ? "xclip" : "wl-copy";
	const args = clip === "xclip" ? ["-selection", "clipboard"] : [];
	return new Promise<ActionResult>((resolve) => {
		const child = execFile(clip, args, (error) => {
			resolve(
				error
					? { ok: false, detail: `复制失败(${clip}):${error.message.split("\n")[0]}\n可手动复制:${text}` }
					: { ok: true, detail: `已复制: ${text}` },
			);
		});
		child.stdin?.end(text);
	}) as unknown as ActionResult;
}
