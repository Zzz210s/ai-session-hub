import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyMatch, fuzzyScore, rankByQuery } from "../src/fuzzy.ts";

test("fuzzyMatch:子序列、忽略大小写与空白", () => {
	assert.equal(fuzzyMatch("cfg", "fix config parser"), true);
	assert.equal(fuzzyMatch("CFG", "fix config"), true);
	assert.equal(fuzzyMatch("登录", "重构登录模块"), true);
	assert.equal(fuzzyMatch("", "任意"), true);
	assert.equal(fuzzyMatch("zzz", "重构登录模块"), false);
});

test("fuzzyScore:匹配返回分数,不匹配返回 null", () => {
	assert.equal(fuzzyScore("zzz", "重构登录"), null);
	const good = fuzzyScore("登录", "重构登录");
	const worse = fuzzyScore("登录", "登录重构" === "登录重构" ? "这是一段很长的无关文本然后才是登录" : "");
	assert.ok(typeof good === "number");
	assert.ok(typeof worse === "number");
	assert.ok((good ?? 0) > (worse ?? 0), "越靠前/越短应得分更高");
});

test("rankByQuery:按分数排序并过滤", () => {
	const items = [
		{ name: "支付回调修复", cwd: "C:/a" },
		{ name: "重构登录模块", cwd: "C:/b" },
		{ name: "无关会话", cwd: "C:/c" },
	];
	const ranked = rankByQuery(items, "登录", (item) => item.name, 10);
	assert.deepEqual(
		ranked.map((item) => item.name),
		["重构登录模块"],
	);
});

test("rankByQuery:空查询时保持原序并受 limit 限制", () => {
	const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
	assert.deepEqual(
		rankByQuery(items, "", (item) => item.name, 2).map((item) => item.name),
		["a", "b"],
	);
});
