import assert from "node:assert/strict";
import { test } from "node:test";
import { hintFor, latestPiVersion, localPiVersion, needsDeploy } from "../src/preflight-run.ts";

test("needsDeploy:仓库或 pi 有变化 -> 部署;否则看 TTL", () => {
	assert.equal(needsDeploy({ reposChanged: true, piChanged: false, now: 0 }), true, "仓库有变化");
	assert.equal(needsDeploy({ reposChanged: false, piChanged: true, now: 0 }), true, "pi 有新版");
	const state = { at: 0 };
	assert.equal(needsDeploy({ reposChanged: false, piChanged: false, state, now: 1000 }), false, "TTL 内且无变化");
	assert.equal(needsDeploy({ reposChanged: false, piChanged: false, state, now: 25 * 3600_000 }), true, "超过 24h 定时刷新");
	assert.equal(needsDeploy({ reposChanged: false, piChanged: false, now: 0 }), true, "无状态(首次)");
});

test("hintFor:24 小时内给提示,超期不给", () => {
	const now = 10 * 3600_000;
	assert.match(hintFor({ at: now - 60_000, summary: "6 步全部完成" }, now), /刚刚|分钟前/);
	assert.match(hintFor({ at: now - 2 * 3600_000, summary: "x" }, now), /小时前/);
	assert.equal(hintFor({ at: now - 30 * 3600_000, summary: "x" }, now), undefined, "超过 24h 不再提示");
	assert.equal(hintFor(undefined, now), undefined);
});

test("版本探测:失败时返回 undefined(离线安全)", async () => {
	const fakeRunner = async () => ({ ok: false, out: "network down" });
	assert.equal(await localPiVersion("definitely-not-a-real-binary"), undefined);
	assert.equal(await latestPiVersion("definitely-not-a-real-npm"), undefined);
	assert.equal(typeof fakeRunner, "function");
});
