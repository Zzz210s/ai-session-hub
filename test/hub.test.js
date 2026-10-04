/**
 * 板面缓存单测(注入假扫描与假指纹,不碰真实扫描/PowerShell):
 *  - 列表没变 → 直接用缓存,不重扫(命中)
 *  - 结构指纹变了 / 超过最长陈旧时间 → 先渲染缓存,后台重扫
 *  - 不带 staleSessions(CLI 语义)→ 忽略缓存,直接扫
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadViews } from "../src/hub.ts";
import { BOARD_MAX_AGE_MS } from "../src/views-cache.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const record = (id) => ({
	tool: "pi",
	id,
	file: `C:/sessions/${id}.jsonl`,
	cwd: "C:\\work\\proj",
	name: id,
	topic: id,
	firstMessage: "",
	createdAt: new Date("2026-10-01T10:00:00Z"),
	updatedAt: new Date("2026-10-01T11:00:00Z"),
});

function boardCache(sessions, { ageMs = 0, signature = "sig-1" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ais-board-"));
	const path = join(dir, "views.json");
	writeFileSync(path, JSON.stringify({ at: Date.now() - ageMs, version: 2, value: { signature, at: Date.now() - ageMs, sessions } }), "utf8");
	return path;
}

function cachedSessions(path) {
	return JSON.parse(readFileSync(path, "utf8")).value.sessions.map((s) => s.id);
}

async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(10);
	}
	return false;
}

function harness({ scanResult, signature = "sig-1" }) {
	const calls = { scans: 0 };
	const scan = async () => {
		calls.scans++;
		return scanResult();
	};
	return { calls, options: { noLive: true, staleSessions: true, scan, signature: () => signature } };
}

test("列表没变:直接用缓存,一次扫描都不做", async () => {
	const path = boardCache([record("a")]);
	const { calls, options } = harness({ scanResult: () => [record("fresh")] });
	const started = Date.now();
	const result = await loadViews({ ...options, viewsCachePath: path });
	assert.equal(calls.scans, 0, "指纹没变不该重扫");
	assert.deepEqual(result.views.map((v) => v.id), ["a"]);
	// 只做"没有阻塞等待"的冒烟检查:并发跑多个测试文件时机器会很忙,阈值放宽
	assert.equal(Date.now() - started < 2000, true, "不该等待扫描");
});

test("结构指纹变了:先给缓存,再后台重扫回写", async () => {
	const path = boardCache([record("old")], { signature: "sig-1" });
	const { calls, options } = harness({ scanResult: () => [record("new1"), record("new2")], signature: "sig-2" });
	const result = await loadViews({ ...options, viewsCachePath: path });
	assert.deepEqual(result.views.map((v) => v.id), ["old"], "先渲染缓存");
	assert.ok(await waitFor(() => calls.scans === 1), "应触发一次后台重扫");
	assert.ok(await waitFor(() => cachedSessions(path).length === 2), "后台重扫应回写缓存");
});

test("超过最长陈旧时间也重扫,即使指纹没变", async () => {
	const path = boardCache([record("old")]);
	const { calls, options } = harness({ scanResult: () => [record("new")] });
	await loadViews({ ...options, viewsCachePath: path, signature: () => "sig-1" });
	assert.equal(calls.scans, 0, "新鲜缓存不重扫");

	const oldPath = boardCache([record("ancient")], { ageMs: BOARD_MAX_AGE_MS + 1_000 });
	const old = harness({ scanResult: () => [record("current")] });
	const result = await loadViews({ ...old.options, viewsCachePath: oldPath });
	assert.deepEqual(result.views.map((v) => v.id), ["ancient"], "先渲染旧的");
	assert.ok(await waitFor(() => old.calls.scans === 1), "超过 60 秒应重扫");
});

test("不带 staleSessions:忽略缓存,直接扫描(CLI 语义)", async () => {
	const path = boardCache([record("cached")]);
	const { calls, options } = harness({ scanResult: () => [record("live1"), record("live2")] });
	const result = await loadViews({ ...options, staleSessions: false, viewsCachePath: path });
	assert.equal(calls.scans, 1);
	assert.equal(result.views.length, 2);
});

test("noCache:不读也不写缓存", async () => {
	const path = boardCache([record("cached")]);
	const before = readFileSync(path, "utf8");
	const { options } = harness({ scanResult: () => [record("direct")] });
	const result = await loadViews({ ...options, noCache: true, viewsCachePath: path });
	assert.deepEqual(result.views.map((v) => v.id), ["direct"]);
	assert.equal(readFileSync(path, "utf8"), before);
});

test("旧格式缓存(裸视图数组)视为无效,直接扫描后升级为新格式", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ais-board-"));
	const path = join(dir, "views.json");
	writeFileSync(path, JSON.stringify({ at: Date.now(), value: [{ tool: "pi", id: "legacy" }] }), "utf8");
	const { calls, options } = harness({ scanResult: () => [record("新格式")] });
	const result = await loadViews({ ...options, viewsCachePath: path });
	assert.equal(calls.scans, 1, "旧格式必须重扫");
	assert.deepEqual(cachedSessions(path), ["新格式"], "应升级为新格式");
});
