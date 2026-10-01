/**
 * 命令行参数解析单测:覆盖启动前自更新的逃生舱与常用开关。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.ts";

test("默认:无参数 -> 进 TUI,不跳过自更新", () => {
	const args = parseArgs([]);
	assert.equal(args.command, "");
	assert.equal(args.noUpdate, false);
	assert.equal(args.json, false);
	assert.equal(args.limit, 40);
});

test("--no-update / --skip-update 被识别为开关,不会被当成命令", () => {
	// 曾经的 bug:第一个 -- 开头的 token 被当作命令 -> "未知命令: --no-update"
	for (const flag of ["--no-update", "--skip-update"]) {
		const args = parseArgs([flag]);
		assert.equal(args.noUpdate, true, flag);
		assert.equal(args.command, "", flag + " 不应成为命令");
	}
});

test("命令与查询词:第一个非开关 token 是命令,其余拼成查询", () => {
	const args = parseArgs(["focus", "comfig", "ai", "--json"]);
	assert.equal(args.command, "focus");
	assert.equal(args.query, "comfig ai");
	assert.equal(args.json, true);
});

test("delete 需 --yes/-y 才真删", () => {
	assert.equal(parseArgs(["delete", "x"]).yes, false);
	assert.equal(parseArgs(["delete", "x", "--yes"]).yes, true);
	assert.equal(parseArgs(["delete", "x", "-y"]).yes, true);
});

test("--limit / --tool= / --live / --no-live / --no-cache", () => {
	assert.equal(parseArgs(["--limit=5"]).limit, 5);
	assert.equal(parseArgs(["--limit="]).limit, 40, "非法值回落到默认");
	assert.deepEqual(parseArgs(["--tool=pi,claude"]).tools, ["pi", "claude"]);
	assert.deepEqual(parseArgs(["--tool=nope"]).tools, undefined, "非法工具名不生效");
	assert.equal(parseArgs(["--live"]).liveOnly, true);
	assert.equal(parseArgs(["--no-live"]).noLive, true);
	assert.equal(parseArgs(["--no-cache"]).noCache, true);
});

test("--fast:识别为快速模式开关", () => {
	const args = parseArgs(["list", "--fast"]);
	assert.equal(args.fast, true);
	assert.equal(args.command, "list");
	assert.equal(parseArgs([]).fast, false);
});

test("gc 与 delete 一样是命令,不是查询词", () => {
	const args = parseArgs(["gc", "--yes"]);
	assert.equal(args.command, "gc");
	assert.equal(args.yes, true);
});
