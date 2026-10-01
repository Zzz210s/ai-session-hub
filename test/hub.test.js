/**
 * 汇总入口的缓存策略单测:
 *  - staleSessions 时用缓存立刻返回,并在后台重扫回写
 *  - 不带 staleSessions 时每次都真扫(CLI 路径)
 * 注:测试用 noLive 跳过 PowerShell;扫描本身走真实实现(带单文件缓存,很快)。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadViews } from "../src/hub.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheFile(value, ageMs) {
	const dir = mkdtempSync(join(tmpdir(), "ais-views-"));
	const path = join(dir, "views.json");
	writeFileSync(path, JSON.stringify({ at: Date.now() - ageMs, value }), "utf8");
	return path;
}

async function waitFor(predicate, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(30);
	}
	return false;
}

test("staleSessions:TTL 内的缓存立刻返回,不再扫描", async () => {
	const path = cacheFile([{ tool: "pi", id: "cached", name: "缓存里的会话" }], 100);
	const started = Date.now();
	const result = await loadViews({ noLive: true, staleSessions: true, viewsCachePath: path });
	assert.equal(Date.now() - started < 800, true, "应立刻返回,不等扫描");
	assert.equal(result.views.length, 1);
	assert.equal(result.views[0].id, "cached");
});

test("staleSessions:过期缓存先渲染(标记后台刷新中),后台把新结果写回", async () => {
	const old = [{ tool: "pi", id: "old", name: "旧快照" }];
	const path = cacheFile(old, 60_000);
	const result = await loadViews({ noLive: true, staleSessions: true, viewsCachePath: path });
	assert.deepEqual(result.views.map((v) => v.id), ["old"], "先给旧快照");
	assert.equal(result.live.stale, true, "应告知这是刷新中的数据");
	assert.ok(await waitFor(() => JSON.parse(readFileSync(path, "utf8")).value.length !== 1), "后台重扫应回写缓存");
});

test("不带 staleSessions:忽略缓存,直接真扫(CLI 语义)", async () => {
	const path = cacheFile([{ tool: "pi", id: "cached", name: "缓存" }], 100);
	const result = await loadViews({ noLive: true, viewsCachePath: path });
	assert.notEqual(result.views.length, 1, "不应只返回缓存里的那一条");
	assert.ok(result.heartbeatCount >= 0);
});

test("noCache:既不读写视图缓存", async () => {
	const path = cacheFile([{ tool: "pi", id: "cached", name: "缓存" }], 100);
	const before = readFileSync(path, "utf8");
	await loadViews({ noLive: true, noCache: true, staleSessions: true, viewsCachePath: path });
	assert.equal(readFileSync(path, "utf8"), before, "缓存文件不该被改写");
});
