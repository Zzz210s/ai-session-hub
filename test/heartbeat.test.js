/**
 * 心跳注册表:GC 决策、目录计数、扫描清理(用临时目录,不动真实注册表)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { countHeartbeats, HEARTBEAT_DEAD_AGE_MS, HEARTBEAT_MAX_AGE_MS, staleHeartbeatNames, sweepHeartbeats } from "../src/live/heartbeat.ts";

const HOUR = 3600_000;

function registry(entries) {
	const dir = mkdtempSync(join(tmpdir(), "ais-hb-"));
	entries.forEach((entry, index) => {
		const name = entry.name ?? `pi-${index}.json`;
		writeFileSync(join(dir, name), entry.raw ?? JSON.stringify({ pid: entry.pid ?? 1, updatedAt: entry.updatedAt }), "utf8");
	});
	return dir;
}

test("staleHeartbeatNames:新鲜文件保留,进程已死且超 24 小时才清", () => {
	const now = Date.now();
	const names = staleHeartbeatNames(
		[
			{ name: "fresh.json", info: { pid: 1, updatedAt: new Date(now - 60_000).toISOString() } },
			{ name: "dead-but-recent.json", info: { pid: 2, updatedAt: new Date(now - 2 * HOUR).toISOString() } },
			{ name: "dead-old.json", info: { pid: 3, updatedAt: new Date(now - 25 * HOUR).toISOString() } },
			{ name: "alive-old.json", info: { pid: 4, updatedAt: new Date(now - 25 * HOUR).toISOString() } },
		],
		now,
		(pid) => pid === 1 || pid === 4,
	);
	assert.deepEqual(names, ["dead-old.json"], "只清进程已死且超 24 小时的那条");
});

test("staleHeartbeatNames:超 7 天一律清(防 pid 复用误判为活着),坏文件也清", () => {
	const now = Date.now();
	const names = staleHeartbeatNames(
		[
			{ name: "very-old-alive.json", info: { pid: 5, updatedAt: new Date(now - HEARTBEAT_MAX_AGE_MS - HOUR).toISOString() } },
			{ name: "broken.json", broken: true },
			{ name: "no-timestamp.json", info: { pid: 6 } },
			{ name: "not-json.txt", info: { pid: 7, updatedAt: new Date(now).toISOString() } },
		],
		now,
		() => true,
	);
	assert.deepEqual(names.sort(), ["broken.json", "no-timestamp.json", "very-old-alive.json"], "非 .json 文件不动");
});

test("staleHeartbeatNames:阈值可读性(days 常量就是 24 小时/7 天)", () => {
	assert.equal(HEARTBEAT_DEAD_AGE_MS, 24 * HOUR);
	assert.equal(HEARTBEAT_MAX_AGE_MS, 7 * 24 * HOUR);
});

test("countHeartbeats:只数 .json,目录不存在返回 0", async () => {
	const dir = registry([{ name: "a.json", updatedAt: new Date().toISOString() }, { name: "note.txt", raw: "x" }]);
	assert.equal(await countHeartbeats(dir), 1);
	assert.equal(await countHeartbeats(join(dir, "nope")), 0);
});

test("sweepHeartbeats:dryRun 只报告不删,实跑删掉且保留新鲜的", async () => {
	const now = Date.now();
	const dir = registry([
		{ name: "old.json", pid: 1, updatedAt: new Date(now - HEARTBEAT_MAX_AGE_MS - HOUR).toISOString() },
		{ name: "fresh.json", pid: 2, updatedAt: new Date(now).toISOString() },
	]);
	const preview = await sweepHeartbeats({ dir, dryRun: true });
	assert.deepEqual(preview.stale, ["old.json"]);
	assert.equal(preview.removed, 0);
	assert.equal(readdirSync(dir).length, 2, "预览不该删东西");

	const done = await sweepHeartbeats({ dir });
	assert.equal(done.removed, 1);
	assert.deepEqual(readdirSync(dir), ["fresh.json"]);
});

test("sweepHeartbeats:keep 指定自己的心跳文件时不动它", async () => {
	const now = Date.now();
	const dir = registry([{ name: "pi-999.json", pid: 1, updatedAt: new Date(now - HEARTBEAT_MAX_AGE_MS - HOUR).toISOString() }]);
	const result = await sweepHeartbeats({ dir, keep: "pi-999.json" });
	assert.deepEqual(result.stale, []);
	assert.equal(readdirSync(dir).length, 1);
});
