import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_TTL_MS,
	MAX_TTL_MS,
	formatAge,
	parseTtl,
	readPreflightState,
	skipReason,
	stateFilePath,
	writePreflightState,
} from "../src/preflight-ttl.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "ais-ttl-"));
}

test("parseTtl:纯毫秒、带单位后缀、0、非法值", () => {
	assert.equal(parseTtl(undefined), DEFAULT_TTL_MS);
	assert.equal(parseTtl(""), DEFAULT_TTL_MS);
	assert.equal(parseTtl("0"), 0, "0 = 每次都查");
	assert.equal(parseTtl("1500"), 1500);
	assert.equal(parseTtl("30s"), 30_000);
	assert.equal(parseTtl("15m"), 900_000);
	assert.equal(parseTtl("2h"), 7_200_000);
	assert.equal(parseTtl("1d"), 86_400_000);
	assert.equal(parseTtl(" 6H "), 21_600_000, "大小写与空白都要容忍");
	assert.equal(parseTtl("abc"), DEFAULT_TTL_MS, "非法值回落默认,不能变成 0(那会每次都查)");
	assert.equal(parseTtl("-5"), DEFAULT_TTL_MS);
});

test("parseTtl:fallback 可注入", () => {
	assert.equal(parseTtl(undefined, 1234), 1234);
	assert.equal(parseTtl("nonsense", 1234), 1234);
});

test("parseTtl:超大值被夹到 30 天上限(写错等于以后再也不更新,那是危险侧)", () => {
	assert.equal(parseTtl("99999999999999999999d"), MAX_TTL_MS);
	assert.equal(parseTtl(String(Number.MAX_SAFE_INTEGER)), MAX_TTL_MS);
});

test("skipReason:TTL 内跳过、过期不跳、无记录不跳、ttl=0 不跳", () => {
	const now = 1_800_000_000_000;
	const ttl = 6 * 3_600_000;
	assert.equal(skipReason({ version: 1 }, now, ttl), undefined, "没有记录:要跑");
	assert.match(String(skipReason({ version: 1, lastSuccessAt: now - 3_600_000 }, now, ttl)), /1\.0 小时前检查过,跳过/);
	assert.equal(skipReason({ version: 1, lastSuccessAt: now - 7 * 3_600_000 }, now, ttl), undefined, "超过 TTL:要跑");
	assert.equal(skipReason({ version: 1, lastSuccessAt: now - 1000 }, now, 0), undefined, "AIS_UPDATE_TTL=0:每次都查");
	assert.equal(skipReason({ version: 1, lastSuccessAt: now + 60_000 }, now, ttl), undefined, "时钟倒退:当作过期,重跑更安全");
});

test("状态文件:写入后能读回,缺失/损坏/版本不符都当作无记录", () => {
	const dir = tempDir();
	try {
		const file = join(dir, "preflight-state.json");
		assert.deepEqual(readPreflightState(file), { version: 1 }, "文件不存在");
		writePreflightState(file, 12345);
		assert.equal(readPreflightState(file).lastSuccessAt, 12345);
		writeFileSync(file, "{ not json", "utf8");
		assert.deepEqual(readPreflightState(file), { version: 1 }, "损坏的 JSON");
		writeFileSync(file, JSON.stringify({ version: 99, lastSuccessAt: 1 }), "utf8");
		assert.deepEqual(readPreflightState(file), { version: 1 }, "版本不符当未命中");
		writeFileSync(file, JSON.stringify({ version: 1, lastSuccessAt: "soon" }), "utf8");
		assert.deepEqual(readPreflightState(file), { version: 1 }, "时间戳类型不对");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("状态文件:目录不存在时自动创建", () => {
	const dir = tempDir();
	try {
		const file = join(dir, "nested", "deep", "preflight-state.json");
		writePreflightState(file, 777);
		assert.equal(readPreflightState(file).lastSuccessAt, 777);
		assert.match(readFileSync(file, "utf8"), /"version": 1/);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("stateFilePath:默认在家目录下,AIS_HOME 可覆盖", () => {
	assert.match(stateFilePath({}), /\.ai-session-hub[\\/]preflight-state\.json$/);
	assert.equal(stateFilePath({ AIS_HOME: "C:\\tmp\\hub" }), join("C:\\tmp\\hub", "preflight-state.json"));
});

test("formatAge:小时/分钟/秒", () => {
	assert.equal(formatAge(3.2 * 3_600_000), "3.2 小时");
	assert.equal(formatAge(12 * 60_000), "12 分钟");
	assert.equal(formatAge(45_000), "45 秒");
	assert.equal(formatAge(200), "1 秒", "不足一秒也显示 1 秒,不显示 0");
});
