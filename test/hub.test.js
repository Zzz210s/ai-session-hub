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
import { BOARD_CACHE_STALE_MS, BOARD_MAX_AGE_MS } from "../src/views-cache.ts";

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

test("隔几小时再开:仍用上次板面做首帧(不再空白),同时后台重扫", async () => {
	// 2026-10-12:缓存窗口从 10 分钟放宽到 6 小时 —— 用户几乎总是隔几小时才开一次 ais,
	// 旧窗口等于首帧永远空白,要等后台扫描才有内容
	const path = boardCache([record("昨晚的板面")], { ageMs: 2 * 60 * 60 * 1000 });
	const { calls, options } = harness({ scanResult: () => [record("今天")] });
	const result = await loadViews({ ...options, viewsCachePath: path });
	assert.deepEqual(result.views.map((v) => v.id), ["昨晚的板面"], "首帧要有内容(这是这次优化的目的)");
	assert.ok(await waitFor(() => calls.scans === 1), "旧快照必须触发后台重扫,≤3 秒后就会被新数据替换");
	assert.ok(await waitFor(() => cachedSessions(path).join() === "今天"), "重扫结果要回写缓存");
});

test("超过 6 小时的缓存视为没有:首帧给空板 + 后台扫描", async () => {
	const path = boardCache([record("远古")], { ageMs: BOARD_CACHE_STALE_MS + 60_000 });
	const { calls, options } = harness({ scanResult: () => [record("fresh")] });
	// TUI 语义:neverBlockSessions → 没缓存时先给空板、后台补上(不阻塞首帧)
	const result = await loadViews({ ...options, neverBlockSessions: true, viewsCachePath: path });
	assert.deepEqual(result.views, [], "超过窗口不该拿旧数据充数");
	assert.ok(await waitFor(() => calls.scans === 1), "应触发后台扫描");
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

test("首次运行(没有板面缓存)+ neverBlockSessions:立刻给空板并触发后台扫描", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "ais-board-")), "views.json");
	const { calls, options } = harness({ scanResult: () => [record("fresh")] });
	const started = Date.now();
	const result = await loadViews({ ...options, viewsCachePath: path, neverBlockSessions: true });
	assert.deepEqual(result.views, [], "先给空板,不等扫描");
	assert.equal(Date.now() - started < 2000, true, "不该等冷扫描(可能几分钟)");
	assert.ok(await waitFor(() => calls.scans === 1), "要触发一次后台重扫");
	assert.ok(await waitFor(() => readFileSync(path, "utf8").includes("fresh")), "扫完要把缓存写回");
});
