/**
 * 打开会话的参数拼装:窗口/标签、profile 继承、几何继承、配置与环境变量覆盖。
 * 只测纯函数 —— 真正 spawn wt 的行为留给人工验证(见 README 的手动验收一节)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEnvOverrides, DEFAULT_OPEN, readOpenConfig } from "../src/open-config.ts";
import { buildWtArgs, resolveGeometry, resolveProfile, sanitizePair } from "../src/open-window.ts";
import { shellArgs } from "../src/shell.ts";
import { profileNameFromEnv } from "../src/console-geometry.ts";

const geometry = { cols: 120, rows: 30, x: 70, y: 77, width: 1199, height: 616, maximized: false, profile: "Cmder" };

const base = {
	mode: "window",
	title: "pi · 测试会话",
	cwd: "F:/0-Note",
	shell: "C:/Program Files/Git/bin/bash.exe",
	shellArgs: ["-lc", "pi --session x"],
	profile: "Cmder",
	size: "120,30",
	pos: "70,77",
	maximized: null,
};

test("新窗口:用 -w -1(不是 new),全局选项排在子命令 nt 之前", () => {
	const args = buildWtArgs(base);
	assert.deepEqual(args.slice(0, 7), ["-w", "-1", "--size", "120,30", "--pos", "70,77", "nt"]);
	assert.equal(args.indexOf("--size") < args.indexOf("nt"), true);
	assert.equal(args.indexOf("nt") < args.indexOf("--profile"), true);
});

test("新标签:用 -w 0 复用当前窗口", () => {
	const args = buildWtArgs({ ...base, mode: "tab" });
	assert.equal(args[0], "-w");
	assert.equal(args[1], "0");
});

test("最大化时不传 size/pos(它们会被忽略,传了反而误导)", () => {
	const args = buildWtArgs({ ...base, maximized: true });
	assert.equal(args.includes("--maximized"), true);
	assert.equal(args.includes("--size"), false);
	assert.equal(args.includes("--pos"), false);
});

test("没有 profile 时不传 --profile,交给 Windows Terminal 默认值", () => {
	const args = buildWtArgs({ ...base, profile: "" });
	assert.equal(args.includes("--profile"), false);
});

test("profile=inherit 时继承探测到的当前 profile", () => {
	assert.equal(resolveProfile(DEFAULT_OPEN, geometry), "Cmder");
	assert.equal(resolveProfile({ ...DEFAULT_OPEN, profile: "Ubuntu" }, geometry), "Ubuntu");
	assert.equal(resolveProfile(DEFAULT_OPEN, null), "");
});

test("geometry=inherit 时复制当前窗口的列行与位置", () => {
	const resolved = resolveGeometry(DEFAULT_OPEN, geometry);
	assert.equal(resolved.size, "120,30");
	assert.equal(resolved.pos, "70,77");
	assert.equal(resolved.maximized, false);
});

test("geometry=none 时不继承;配置里的显式值仍然生效", () => {
	const none = resolveGeometry({ ...DEFAULT_OPEN, geometry: "none" }, geometry);
	assert.deepEqual(none, { size: null, pos: null, maximized: null });
	const explicit = resolveGeometry({ ...DEFAULT_OPEN, geometry: "none", size: "100,40", maximized: true }, geometry);
	assert.equal(explicit.size, "100,40");
	assert.equal(explicit.maximized, true);
});

test("探测失败(不在 Windows Terminal 里跑)时退回 WT 默认几何", () => {
	const resolved = resolveGeometry(DEFAULT_OPEN, null);
	assert.deepEqual(resolved, { size: null, pos: null, maximized: null });
});

test("配置文件缺失或损坏时用默认值,不抛错", () => {
	const missing = readOpenConfig("nope.json", () => {
		throw new Error("ENOENT");
	});
	assert.deepEqual(missing, DEFAULT_OPEN);
	const broken = readOpenConfig("bad.json", () => "{ not json");
	assert.deepEqual(broken, DEFAULT_OPEN);
});

test("配置文件只写一部分时,其余取默认", () => {
	const config = readOpenConfig("c.json", () => JSON.stringify({ open: { mode: "tab", size: "100,40" } }));
	assert.equal(config.mode, "tab");
	assert.equal(config.size, "100,40");
	assert.equal(config.profile, "inherit");
	assert.equal(config.geometry, "inherit");
});

test("环境变量覆盖配置文件", () => {
	const config = applyEnvOverrides(
		{ ...DEFAULT_OPEN, mode: "tab" },
		{ AIS_OPEN_MODE: "window", AIS_OPEN_PROFILE: "Ubuntu", AIS_OPEN_MAXIMIZED: "true", AIS_OPEN_SIZE: "90,25" },
	);
	assert.equal(config.mode, "window");
	assert.equal(config.profile, "Ubuntu");
	assert.equal(config.maximized, true);
	assert.equal(config.size, "90,25");
});

test("环境变量写错值时不生效(保持配置文件口径)", () => {
	const config = applyEnvOverrides(DEFAULT_OPEN, { AIS_OPEN_MODE: "split", AIS_OPEN_GEOMETRY: "maybe" });
	assert.equal(config.mode, DEFAULT_OPEN.mode);
	assert.equal(config.geometry, DEFAULT_OPEN.geometry);
});

test("几何值非法时丢弃(否则 wt 会去启动一个叫 100,25 的程序)", () => {
	assert.equal(sanitizePair("120,30", 10, 500), "120,30");
	assert.equal(sanitizePair("0,0", 10, 500), null);
	assert.equal(sanitizePair("abc", 10, 500), null);
	assert.equal(sanitizePair("120", 10, 500), null);
	assert.equal(sanitizePair("9999,30", 10, 500), null);
	assert.equal(sanitizePair(null, 10, 500), null);
});

test("探测到 0 列 0 行时不继承(交给 WT 默认)", () => {
	const zero = { cols: 0, rows: 0, x: 0, y: 0, width: 0, height: 0, maximized: false, profile: "" };
	assert.deepEqual(resolveGeometry(DEFAULT_OPEN, zero), { size: null, pos: null, maximized: false });
});

test("交给 wt 的命令里不能出现分号(WT 会把 `;` 当自己的命令分隔符,多开一个报错页)", () => {
	const bash = shellArgs("C:/Program Files/Git/bin/bash.exe", 'pi --session "x.jsonl"', { keepAlive: false }).command;
	const ps = shellArgs("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "pi --session x", { keepAlive: false }).command;
	for (const args of [bash, ps]) {
		for (const arg of args) assert.equal(arg.includes(";"), false, `不该有分号: ${arg}`);
	}
	const wt = buildWtArgs({ ...base, shellArgs: bash });
	for (const arg of wt) assert.equal(arg.includes(";"), false, `wt 参数不该有分号: ${arg}`);
});

test("默认就是开当前窗口的新标签(ais 自己就在那个窗口里)", () => {
	assert.equal(DEFAULT_OPEN.mode, "tab");
	const args = buildWtArgs({ ...base, mode: "tab" });
	assert.deepEqual(args.slice(0, 2), ["-w", "0"]);
});

test("profile 名直接从 WT_PROFILE_ID 解出(不跑 powershell,也就不会超时退化成默认 profile)", () => {
	const settings = JSON.stringify({
		profiles: { list: [{ name: "Cmder · Claude", guid: "{8AC0556A-DFAA-4100-BF4D-B80DEA441451}" }, { name: "Windows PowerShell", guid: "{61C54BBD-C2C6-5271-96E7-009A87FF44BF}" }] },
	});
	const env = { WT_PROFILE_ID: "{8ac0556a-dfaa-4100-bf4d-b80dea441451}", LOCALAPPDATA: "C:/fake" };
	const name = profileNameFromEnv(env, () => "﻿" + settings);
	assert.equal(name, "Cmder · Claude");
	assert.equal(profileNameFromEnv({}, () => settings), "", "不在 WT 里跑时为空");
});

test("resolveProfile:配置优先,其次环境变量,最后才是探测结果", () => {
	assert.equal(resolveProfile({ ...DEFAULT_OPEN, profile: "Ubuntu" }, geometry, "Cmder"), "Ubuntu");
	assert.equal(resolveProfile(DEFAULT_OPEN, null, "Cmder"), "Cmder");
	assert.equal(resolveProfile(DEFAULT_OPEN, geometry, ""), "Cmder");
});
