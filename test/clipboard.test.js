/**
 * 剪贴板写入:stdin 提前关闭时必须按失败返回,不能抛 uncaught(否则"提示已复制其实没复制")。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipboardCommand, writeClipboard } from "../src/clipboard.ts";

test("clipboardCommand:Windows 用 clip.exe,Linux 优先 Wayland 的 wl-copy", () => {
	assert.deepEqual(clipboardCommand({}, "win32"), { clip: "clip.exe", args: [] });
	assert.deepEqual(clipboardCommand({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), { clip: "wl-copy", args: [] });
	assert.deepEqual(clipboardCommand({ DISPLAY: ":0" }, "linux"), { clip: "xclip", args: ["-selection", "clipboard"] });
});

test("writeClipboard:子进程提前关闭 stdin 按失败返回(EOF 不再 uncaught)", async () => {
	const [clip, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "exit"]] : ["sh", ["-c", "exit"]];
	const result = await writeClipboard("x".repeat(300000), clip, args);
	assert.equal(result.ok, false, "stdin 写不进去就不该报成功");
	assert.match(result.detail, /复制失败/);
});

test("writeClipboard:正常命令写入后回「已复制: 文本」", async () => {
	const [clip, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "more"]] : ["cat", []];
	const result = await writeClipboard("hello", clip, args);
	assert.deepEqual(result, { ok: true, detail: "已复制: hello" });
});
