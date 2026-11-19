/**
 * heartbeat-trust.ts 的单测:心跳可信度判定的每条规则都要有据可依
 * (判错的代价不对称 —— 误判"不可信"会删掉正在写入的会话,误判"可信"会让会话删不掉)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { HEARTBEAT_STALE_MS, heartbeatAgeMs, heartbeatTrusted, sessionFileFromArgs } from "../src/live/heartbeat-trust.ts";

const fresh = () => new Date().toISOString();
const old = () => new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString();

const hb = (over = {}) => ({
	tool: "pi",
	pid: 4242,
	sessionId: "sess-1",
	sessionFile: "C:\\sessions\\1.jsonl",
	status: "idle",
	updatedAt: fresh(),
	...over,
});

const proc = (over = {}) => ({
	pid: 4242,
	tool: "pi",
	startedAt: new Date(),
	args: 'node C:/pi/cli.js --session "C:\\sessions\\1.jsonl"',
	...over,
});

test("sessionFileFromArgs:带引号/等号/不带引号都能取到", () => {
	assert.equal(sessionFileFromArgs('node cli.js --session "C:\\a\\b.jsonl"'), "C:\\a\\b.jsonl");
	assert.equal(sessionFileFromArgs("node cli.js --session=C:/a/b.jsonl"), "C:/a/b.jsonl");
	assert.equal(sessionFileFromArgs("node cli.js --session C:/a/b.jsonl"), "C:/a/b.jsonl");
	assert.equal(sessionFileFromArgs("node cli.js --continue"), undefined);
	assert.equal(sessionFileFromArgs(""), undefined);
});

test("heartbeatAgeMs:能算,坏值返回 undefined", () => {
	assert.equal(heartbeatAgeMs(fresh()) !== undefined, true);
	assert.equal(heartbeatAgeMs("not-a-date"), undefined);
	assert.equal(heartbeatAgeMs(undefined), undefined);
	assert.equal(heartbeatAgeMs(""), undefined);
});

test("可信:新鲜心跳 + 命令行指向同一会话", () => {
	assert.equal(heartbeatTrusted(hb(), [proc()]).trusted, true);
});

test("不可信:心跳过期(会话早关了,记录残留)", () => {
	const verdict = heartbeatTrusted(hb({ updatedAt: old() }), []);
	assert.equal(verdict.trusted, false);
	assert.match(String(verdict.reason), /过期/);
});

test("不可信:pid 被别的程序复用", () => {
	const verdict = heartbeatTrusted(hb(), [proc({ tool: "claude", args: "claude.exe" })]);
	assert.equal(verdict.trusted, false);
	assert.match(String(verdict.reason), /占用/);
});

test("不可信:同 pid 是 pi,但命令行指向另一个会话", () => {
	const verdict = heartbeatTrusted(hb(), [proc({ args: 'node cli.js --session "C:\\sessions\\OTHER.jsonl"' })]);
	assert.equal(verdict.trusted, false);
	assert.match(String(verdict.reason), /另一个会话/);
});

test("可信:探测里没有这个 pid(信息不全不能当死)", () => {
	assert.equal(heartbeatTrusted(hb(), []).trusted, true);
	assert.equal(heartbeatTrusted(hb(), [proc({ pid: 999 })]).trusted, true);
});

test("可信:命令行没写会话文件时保守信任", () => {
	assert.equal(heartbeatTrusted(hb(), [proc({ args: "node cli.js --continue" })]).trusted, true);
});

test("可信:心跳没有 sessionFile 时不做文件比对(退回到工具比对)", () => {
	assert.equal(heartbeatTrusted(hb({ sessionFile: undefined }), [proc()]).trusted, true);
});

test("可信:心跳时间无法解析时保守信任", () => {
	assert.equal(heartbeatTrusted(hb({ updatedAt: "garbage" }), []).trusted, true);
});
