/**
 * 汇总入口的缓存策略单测(注入假 loader,不碰真实扫描/PowerShell,故在并行测试下也稳定):
 *  - TTL 内的缓存立刻返回,不再加载
 *  - 过期缓存先渲染并标记"刷新中",后台把新结果写回
 *  - 不带 staleSessions 时忽略缓存,直接加载(CLI 语义)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadViews } from "../src/hub.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const view = (id) => ({ tool: "pi", id, name: id, state: "stored", attention: false });
const result = (ids) => ({ views: ids.map(view), live: { processes: [], tabs: [], consoleWindows: [] }, heartbeatCount: 0 });

function cacheFile(value, ageMs) {
	const dir = mkdtempSync(join(tmpdir(), "ais-views-"));
	const path = join(dir, "views.json");
	writeFileSync(path, JSON.stringify({ at: Date.now() - ageMs, value }), "utf8");
	return path;
}

function cachedIds(path) {
	return JSON.parse(readFileSync(path, "utf8")).value.map((v) => v.id);
}

async function waitFor(predicate, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(10);
	}
	return false;
}

test("staleSessions:TTL 内的缓存立刻返回,不再加载", async () => {
	const path = cacheFile([view("cached")], 100);
	let loads = 0;
	const started = Date.now();
	const result = await loadViews({ staleSessions: true, viewsCachePath: path, loader: async () => (loads++, result(["fresh"])) });
	assert.equal(Date.now() - started < 500, true, "不该等加载");
	assert.deepEqual(result.views.map((v) => v.id), ["cached"]);
	assert.equal(loads, 0);
});

test("staleSessions:过期缓存先渲染(标记刷新中),后台把新结果写回", async () => {
	const path = cacheFile([view("old")], 60_000);
	const loaded = await loadViews({ staleSessions: true, viewsCachePath: path, loader: async () => result(["new1", "new2"]) });
	assert.deepEqual(loaded.views.map((v) => v.id), ["old"], "先给旧快照");
	assert.equal(loaded.live.stale, true, "应告知界面这是刷新中的数据");
	assert.ok(await waitFor(() => cachedIds(path).length === 2), "后台加载应把新结果写回缓存");
});

test("不带 staleSessions:忽略缓存,直接加载(CLI 语义)", async () => {
	const path = cacheFile([view("cached")], 100);
	const loaded = await loadViews({ viewsCachePath: path, loader: async () => result(["live1", "live2", "live3"]) });
	assert.equal(loaded.views.length, 3, "应返回刚加载的结果,而不是缓存那一条");
	assert.equal(loaded.live.stale, undefined);
});

test("缓存太旧(超过 10 分钟)不算可用,直接加载", async () => {
	const path = cacheFile([view("ancient")], 3600_000);
	const loaded = await loadViews({ staleSessions: true, viewsCachePath: path, loader: async () => result(["current"]) });
	assert.deepEqual(loaded.views.map((v) => v.id), ["current"]);
});

test("noCache:既不读也不写视图缓存", async () => {
	const path = cacheFile([view("cached")], 100);
	const before = readFileSync(path, "utf8");
	const loaded = await loadViews({ noCache: true, staleSessions: true, viewsCachePath: path, loader: async () => result(["direct"]) });
	assert.deepEqual(loaded.views.map((v) => v.id), ["direct"]);
	await sleep(50);
	assert.equal(readFileSync(path, "utf8"), before, "缓存文件不该被改写");
});
