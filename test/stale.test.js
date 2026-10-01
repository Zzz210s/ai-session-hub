/**
 * "先给旧的、后台刷新"决策的单测:三种情形(fresh / 过期可接受 / 必须同步取)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planFetch } from "../src/stale.ts";

test("fresh 命中:直接用,取与刷新都不做", () => {
	assert.deepEqual(planFetch({ fresh: "F" }, { allowStale: false }), { use: "F", fetch: false, refresh: false });
	assert.deepEqual(planFetch({ fresh: "F" }, { allowStale: true }), { use: "F", fetch: false, refresh: false });
});

test("只有过期值:允许 stale 就先渲染并后台刷新,不允许就同步取", () => {
	assert.deepEqual(planFetch({ stale: "S" }, { allowStale: false }), { fetch: true, refresh: false });
	assert.deepEqual(planFetch({ stale: "S" }, { allowStale: true }), { use: "S", fetch: false, refresh: true });
});

test("两者都没有:同步取", () => {
	assert.deepEqual(planFetch({}, { allowStale: true }), { fetch: true, refresh: false });
});

test("fresh 优先于 stale(不会被过期值顶掉)", () => {
	assert.deepEqual(planFetch({ fresh: "F", stale: "S" }, { allowStale: true }), { use: "F", fetch: false, refresh: false });
});
