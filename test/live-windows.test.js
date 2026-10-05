/**
 * GUI 窗口枚举的解析(纯函数)。不启动 PowerShell、不依赖真实窗口列表 ——
 * 真机冒烟见 task-7-report.md,这里保证解析逻辑在任意机器上都能跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuiWindows } from "../src/live/windows.ts";
import { parseWmctrlOutput } from "../src/live/linux.ts";

test("parseGuiWindows:按进程名认出 zed/dsh,过滤空标题与其它进程", () => {
	const apps = parseGuiWindows([
		{ hwnd: "0x10", pid: 100, process: "zed.exe", title: "proj - Zed" },
		{ hwnd: "0x20", pid: 200, process: "DeepSeek Harness.exe", title: "config-ai - DeepSeek Harness" },
		{ hwnd: "0x30", pid: 300, process: "explorer.exe", title: "桌面" },
		{ hwnd: "0x40", pid: 400, process: "zed.exe", title: "" },
	]);
	assert.deepEqual(
		apps.map((a) => [a.tool, a.pid]),
		[["zed", 100], ["dsh", 200]],
	);
});

test("parseGuiWindows:进程名大小写不敏感,标题与句柄原样保留", () => {
	const [zed] = parseGuiWindows([{ hwnd: "0x1a", pid: 7, process: "ZED.EXE", title: "x - Zed" }]);
	assert.deepEqual(zed, { tool: "zed", pid: 7, hwnd: "0x1a", title: "x - Zed" });
});

test("parseGuiWindows:非数组输入与残缺行不抛错", () => {
	assert.deepEqual(parseGuiWindows(null), []);
	assert.deepEqual(parseGuiWindows({}), []);
	assert.deepEqual(parseGuiWindows([null, 42, { process: "zed.exe" }]), []);
});

test("parseGuiWindows:64 位高地址句柄保留十六进制,不溢出成负数", () => {
	const [app] = parseGuiWindows([{ hwnd: "0x7ffd00001234", pid: 9, process: "zed.exe", title: "t" }]);
	assert.equal(app.hwnd, "0x7ffd00001234");
});

test("parseWmctrlOutput:按标题认出 zed/dsh,忽略其它窗口", () => {
	const out = [
		"0x03400007  12345  host  proj - Zed",
		"0x0360000a  23456  host  config-ai - DeepSeek Harness",
		"0x0380000b  34567  host  Terminal",
		"",
	].join("\n");
	assert.deepEqual(
		parseWmctrlOutput(out).map((a) => [a.tool, a.pid, a.hwnd]),
		[
			["zed", 12345, "0x03400007"],
			["dsh", 23456, "0x0360000a"],
		],
	);
});

test("parseWmctrlOutput:空输出与乱行返回空数组", () => {
	assert.deepEqual(parseWmctrlOutput(""), []);
	assert.deepEqual(parseWmctrlOutput("garbage\n"), []);
});
