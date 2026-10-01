/**
 * 活体探测调度(缓存策略)单测(不启动 PowerShell,注入假 probe + 临时缓存文件)。
 * 关键行为:首帧允许用过期快照(避免等 1-2 秒探测),过期快照不会污染缓存。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeLive } from "../src/live/probe.ts";

const snapshot = (mark) => ({ processes: [], tabs: [], consoleWindows: [], error: undefined, mark });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempCache(pattern = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ais-live-"));
	const path = join(dir, "live.json");
	if (pattern.at !== undefined) writeFileSync(path, JSON.stringify({ at: pattern.at, value: pattern.value }), "utf8");
	return path;
}

function ageOf(path) {
	return JSON.parse(readFileSync(path, "utf8")).at;
}

async function waitFor(predicate, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(20);
	}
	return false;
}

test("probeLive:命中新鲜缓存时不探测", async () => {
	const path = tempCache({ at: Date.now(), value: snapshot("cached") });
	let probes = 0;
	const result = await probeLive({ cachePath: path, ttlMs: 60_000, staleMs: 60_000, probe: async () => (probes++, snapshot("live")) });
	assert.equal(result.mark, "cached");
	assert.equal(probes, 0, "新鲜缓存不该触发探测");
});

test("probeLive:过期缓存 + allowStale → 立刻返回旧快照并标记 stale,后台刷新缓存", async () => {
	const path = tempCache({ at: Date.now() - 60_000, value: snapshot("stale") });
	const started = Date.now();
	const result = await probeLive({
		cachePath: path,
		ttlMs: 1000,
		staleMs: 10 * 60_000,
		allowStale: true,
		probe: async () => (await sleep(120), snapshot("fresh")),
	});
	assert.equal(result.mark, "stale", "应返回旧快照");
	assert.equal(result.stale, true, "应标记为过期");
	assert.ok(Date.now() - started < 100, "不该等待探测完成");
	assert.ok(await waitFor(() => ageOf(path) > started), "后台刷新应把新快照写进缓存");
});

test("probeLive:过期缓存但不允许 stale → 同步探测并回写缓存", async () => {
	const path = tempCache({ at: Date.now() - 60_000, value: snapshot("stale") });
	const result = await probeLive({ cachePath: path, ttlMs: 1000, probe: async () => snapshot("fresh") });
	assert.equal(result.mark, "fresh");
	assert.equal(result.stale, undefined, "同步探测的结果不算 stale");
	assert.ok(ageOf(path) > Date.now() - 5000, "应回写缓存时间");
});

test("probeLive:超过 staleMs 的缓存不再算可用,直接同步探测", async () => {
	const path = tempCache({ at: Date.now() - 3600_000, value: snapshot("ancient") });
	const result = await probeLive({ cachePath: path, ttlMs: 1000, staleMs: 60_000, allowStale: true, probe: async () => snapshot("fresh") });
	assert.equal(result.mark, "fresh", "太旧就不该拿来渲染");
});

test("probeLive:noCache 只探测不读也不写缓存", async () => {
	const path = tempCache({ at: Date.now(), value: snapshot("cached") });
	const result = await probeLive({ cachePath: path, noCache: true, probe: async () => snapshot("live") });
	assert.equal(result.mark, "live");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).value.mark, "cached", "不应覆盖缓存");
});
