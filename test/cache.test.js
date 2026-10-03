/**
 * 磁盘缓存:TTL、格式版本、清理。
 *
 * 版本是这次加的重点:v1 的缓存里存着"会话名取第一条 session_info"推导出的旧名字,
 * 若不按版本丢弃,改完代码后旧名字还会命中(扫描缓存 TTL 24 小时)。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CACHE_FORMAT_VERSION, clearCache, readCache, writeCache } from "../src/cache.ts";
import { cachedScan, readScanCache } from "../src/scan/cache.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "ais-cache-"));
}

test("readCache/writeCache:写入后能读回,TTL 过期后读不到", async () => {
	const path = join(tempDir(), "c.json");
	await writeCache({ path, ttlMs: 60_000 }, { hello: "world" });
	assert.deepEqual(await readCache({ path, ttlMs: 60_000 }), { hello: "world" });
	assert.equal(await readCache({ path, ttlMs: 0 }), undefined, "TTL=0 视为禁用");
});

test("格式版本不符 → 当作未命中(这是旧名字能活 24 小时的原因)", async () => {
	const dir = tempDir();
	const path = join(dir, "c.json");
	await writeCache({ path, ttlMs: 60_000 }, { name: "新" });
	assert.deepEqual(await readCache({ path, ttlMs: 60_000 }), { name: "新" });

	// 模拟磁盘上是上一个格式版本写的值
	writeFileSync(path, JSON.stringify({ at: Date.now(), version: CACHE_FORMAT_VERSION - 1, value: { name: "旧" } }), "utf8");
	assert.equal(await readCache({ path, ttlMs: 60_000 }), undefined);

	// 更老的格式连 version 字段都没有
	writeFileSync(path, JSON.stringify({ at: Date.now(), value: { name: "更旧" } }), "utf8");
	assert.equal(await readCache({ path, ttlMs: 60_000 }), undefined);
});

test("扫描缓存:版本不符时整份丢弃,相符时正常读回", async () => {
	const dir = tempDir();
	const path = join(dir, "sessions.json");
	const entries = { "f.jsonl|10|20": { size: 10, mtimeMs: 20, value: { name: "会话" } } };

	writeFileSync(path, JSON.stringify({ entries }), "utf8");
	assert.deepEqual(await readScanCache(path), {}, "旧格式(无 version)必须被忽略");

	writeFileSync(path, JSON.stringify({ version: CACHE_FORMAT_VERSION, entries }), "utf8");
	assert.deepEqual(await readScanCache(path), entries);
});

test("clearCache:清空指定缓存目录(顺带守住曾用 path.join 但没导入 path 的崩溃)", async () => {
	const dir = tempDir();
	writeFileSync(join(dir, "a.json"), "{}", "utf8");
	writeFileSync(join(dir, "b.json"), "{}", "utf8");
	await clearCache(dir);
	assert.deepEqual(readdirSync(dir), [], "目录被清空");
	assert.ok(!existsSync(join(dir, "a.json")));
	await clearCache(join(dir, "不存在的目录")); // 不该抛错
});

test("cachedScan:文件没变时不该重算(这条能抓出“stat 没导入 → 缓存静默失效”)", async () => {
	const dir = tempDir();
	const file = join(dir, "s.jsonl");
	writeFileSync(file, "line1" + String.fromCharCode(10), "utf8");
	let computes = 0;
	const compute = async () => {
		computes++;
		return { name: `第 ${computes} 次` };
	};
	const first = await cachedScan(file, compute);
	const second = await cachedScan(file, compute);
	assert.equal(computes, 1, "第二次必须命中缓存");
	assert.deepEqual(second, first);

	// 文件变化(size 或 mtime)后必须重算
	writeFileSync(file, "line1" + String.fromCharCode(10) + "line2" + String.fromCharCode(10), "utf8");
	await cachedScan(file, compute);
	assert.equal(computes, 2, "指纹变了要重算");

	// 拿不到指纹(文件不存在)时退化为直接计算,不缓存也不抛错
	const missing = join(dir, "nope.jsonl");
	assert.deepEqual(await cachedScan(missing, compute), { name: "第 3 次" });
	assert.equal(computes, 3);
	assert.ok(!existsSync(missing));
	assert.ok(statSync(file).size > 0);
});
