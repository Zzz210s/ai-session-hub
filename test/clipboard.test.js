/**
 * 剪贴板写入:非 ASCII 不能走 clip.exe(它按控制台代码页 CP936 解 stdin 的 UTF-8 字节),
 * 故 Windows 断言命令选择与 base64 注入;stdin 提前关闭时必须按失败返回,不能报成功。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, unlinkSync } from "node:fs";
import { clipboardPlan, runClipboardPlan, writeClipboard } from "../src/clipboard.ts";

const WIN = process.platform === "win32";

test("clipboardPlan:Windows 用 PowerShell 内联 base64,不把文本喂给 clip.exe", () => {
	const text = "测试ABC123 · 中文路径 F:\\0-Note";
	const plan = clipboardPlan(text, {}, "win32");
	assert.match(plan.clip, /powershell\.exe$/);
	assert.equal(plan.stdin, "", "Windows 下文本编进命令行参数,stdin 应为空");
	const script = plan.args.join(" ");
	assert.match(script, /Set-Clipboard/);
	const encoded = script.match(/FromBase64String\('([^']*)'\)/);
	assert.ok(encoded, "脚本应含 base64 参数");
	assert.equal(Buffer.from(encoded[1], "base64").toString("utf8"), text, "base64 应能还原原文");
	assert.equal(plan.fallback?.clip, "clip.exe", "PowerShell 缺失时应能退回 clip.exe");
});

test("clipboardPlan:空文本仍走 PowerShell(Set-Clipboard 不接受空串,脚本里换成 $null)", () => {
	const plan = clipboardPlan("", {}, "win32");
	assert.equal(plan.stdin, "");
	const script = plan.args.join(" ");
	assert.equal(script.match(/FromBase64String\('([^']*)'\)/)?.[1], "");
	assert.match(script, /\$null/, "空串要换成 $null 才不会让 Set-Clipboard 报错");
});

test("clipboardPlan:超长文本改用临时文件,不内联到命令行", () => {
	const text = "x".repeat(5000);
	const plan = clipboardPlan(text, {}, "win32");
	assert.equal(plan.stdin, "");
	const script = plan.args.join(" ");
	assert.match(script, /ReadAllText/);
	assert.ok(!script.includes(Buffer.from(text, "utf8").toString("base64")), "不该内联 base64");
	const matched = script.match(/'([^']*ais-clipboard-[^']*\.txt)'/);
	assert.ok(matched, "脚本里应带临时文件路径");
	assert.ok(existsSync(matched[1]), "计划生成时临时文件应已写入");
	unlinkSync(matched[1]);
});

test("clipboardPlan:Linux 优先 Wayland 的 wl-copy,再 xclip,文本走 stdin", () => {
	assert.deepEqual(clipboardPlan("hi", {}, "linux"), { clip: "wl-copy", args: [], stdin: "hi", text: "hi" });
	assert.deepEqual(clipboardPlan("hi", { WAYLAND_DISPLAY: "wayland-0" }, "linux"), {
		clip: "wl-copy",
		args: [],
		stdin: "hi",
		text: "hi",
	});
	assert.deepEqual(clipboardPlan("hi", { DISPLAY: ":0" }, "linux"), {
		clip: "xclip",
		args: ["-selection", "clipboard"],
		stdin: "hi",
		text: "hi",
	});
});

test("writeClipboard:子进程提前关闭 stdin 按失败返回(EOF 不再 uncaught)", async () => {
	const [clip, args] = WIN ? ["cmd.exe", ["/c", "exit"]] : ["sh", ["-c", "exit"]];
	const result = await writeClipboard({ clip, args, stdin: "x".repeat(300000), text: "big" });
	assert.equal(result.ok, false, "stdin 写不进去就不该报成功");
	assert.match(result.detail, /复制失败/);
});

test("writeClipboard:正常命令写入后回「已复制: 文本」", async () => {
	const [clip, args] = WIN ? ["cmd.exe", ["/c", "more"]] : ["cat", []];
	const result = await writeClipboard({ clip, args, stdin: "hello", text: "hello" });
	assert.deepEqual(result, { ok: true, detail: "已复制: hello" });
});

test("writeClipboard:命令不存在时按失败返回且不挂起(回归:spawn 失败只 emit close)", async () => {
	const result = await Promise.race([
		writeClipboard({ clip: "definitely-not-a-command-xyz", args: [], stdin: "x", text: "x" }),
		new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 3000)),
	]);
	assert.notEqual(result, "TIMEOUT", "spawn ENOENT 不该让 Promise 永久 pending");
	assert.equal(result.ok, false);
	assert.match(result.detail, /复制失败/);
});

test("writeClipboard:子进程不读 stdin 也不退出时由 timeout 兜底", async () => {
	const plan = { clip: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"], stdin: "x", text: "x" };
	const result = await writeClipboard(plan, 300);
	assert.equal(result.ok, false);
	assert.match(result.detail, /复制失败/);
});

test("runClipboardPlan:命令缺失时按 fallback 回退,并如实说明可能乱码", async () => {
	const [clip, args] = WIN ? ["cmd.exe", ["/c", "more"]] : ["cat", []];
	const result = await runClipboardPlan({
		clip: "definitely-not-a-command-xyz",
		args: [],
		stdin: "x",
		text: "x",
		fallback: { clip, args, stdin: "x", text: "x" },
	});
	assert.equal(result.ok, true);
	assert.match(result.detail, /回退/);
});
