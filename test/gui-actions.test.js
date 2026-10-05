/**
 * GUI 动作层单测:失败文案映射与平台分支(不真碰窗口/剪贴板)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFocusFailure, focusApp } from "../src/gui-actions.ts";

const snapshot = (apps) => ({ processes: [], tabs: [], consoleWindows: [], apps });

test("describeFocusFailure:FOCUS_FAILED 变成中文 + 操作指引,不出现裸英文码", () => {
	const text = describeFocusFailure("zed", "FOCUS_FAILED");
	assert.match(text, /无法把 Zed 窗口切到前台/);
	assert.match(text, /先点一下窗口/);
	assert.ok(!text.includes("FOCUS_FAILED"));
});

test("describeFocusFailure:WINDOW_NOT_FOUND / BAD_HWND 各有可操作说明", () => {
	const notFound = describeFocusFailure("dsh", "WINDOW_NOT_FOUND");
	assert.match(notFound, /没找到 DeepSeek Harness 的窗口/);
	assert.ok(!notFound.includes("WINDOW_NOT_FOUND"));
	const bad = describeFocusFailure("zed", "BAD_HWND");
	assert.match(bad, /窗口句柄无效/);
	assert.ok(!bad.includes("BAD_HWND"));
});

test("describeFocusFailure:未知码保留原文但带中文前缀", () => {
	const text = describeFocusFailure("zed", "SOME_NEW_CODE");
	assert.match(text, /^聚焦 Zed 失败:/);
	assert.ok(text.includes("SOME_NEW_CODE"));
});

test("focusApp:应用没在运行时用中文展示名", async () => {
	const result = await focusApp("dsh", { platform: "linux", probe: async () => snapshot([]) });
	assert.equal(result.ok, false);
	assert.match(result.detail, /DeepSeek Harness 没在运行/);
	assert.ok(!result.detail.includes("dsh 没在运行"));
});

test("focusApp:Windows 聚焦失败时把码翻成中文", async () => {
	const result = await focusApp("zed", {
		platform: "win32",
		probe: async () => snapshot([{ tool: "zed", pid: 1, hwnd: "0x1", title: "23652" }]),
		focusWindows: async () => ({ ok: false, detail: "FOCUS_FAILED" }),
	});
	assert.equal(result.ok, false);
	assert.match(result.detail, /无法把 Zed 窗口切到前台/);
	assert.ok(!result.detail.includes("FOCUS_FAILED"));
});

test("focusApp:Linux 传 app.hwnd(走 wmctrl -i -a),不回喂标题", async () => {
	const seen = [];
	const result = await focusApp("zed", {
		platform: "linux",
		probe: async () => snapshot([{ tool: "zed", pid: 1, hwnd: "0xabc", title: "23652" }]),
		focusLinux: async (title, hwnd) => {
			seen.push([title, hwnd]);
			return { ok: true, detail: "已聚焦窗口(0xabc)" };
		},
	});
	assert.deepEqual(seen, [["23652", "0xabc"]]);
	assert.deepEqual(result, { ok: true, detail: "已聚焦 Zed 窗口" });
});
