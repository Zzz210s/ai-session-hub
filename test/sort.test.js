import assert from "node:assert/strict";
import { test } from "node:test";
import { asSortMode, nextSortMode, sortBucket, sortName, sortRows } from "../src/sort.ts";

const view = (name, { updated = 0, tool = "pi", topic = "" } = {}) => ({
	id: `id-${name}`,
	tool,
	name,
	topic: topic || name,
	file: "",
	cwd: "C:/w",
	firstMessage: "",
	createdAt: new Date(updated),
	updatedAt: new Date(updated),
	state: "stored",
	attention: false,
});

test("nextSortMode:默认 → 字母 → 默认(按键循环)", () => {
	assert.equal(nextSortMode("default"), "alpha");
	assert.equal(nextSortMode("alpha"), "default");
});

test("asSortMode:只认 alpha / default(别的一律 undefined,配置写错不炸)", () => {
	assert.equal(asSortMode("alpha"), "alpha");
	assert.equal(asSortMode("default"), "default");
	assert.equal(asSortMode("name"), undefined);
	assert.equal(asSortMode(undefined), undefined);
});

test("sortRows:默认顺序原样返回(不复制、不重排)", () => {
	const rows = [view("b", { updated: 300 }), view("a", { updated: 100 })];
	assert.equal(sortRows(rows, "default"), rows, "默认应返回同一个数组,避免每帧多一次复制");
});

test("sortRows:字母序按名字排,且不改动入参数组", () => {
	const rows = [view("博客&笔记", { updated: 900 }), view("ais", { updated: 100 }), view("Zed 面板汉化", { updated: 500 })];
	const sorted = sortRows(rows, "alpha");
	assert.deepEqual(sorted.map((r) => r.name), ["ais", "Zed 面板汉化", "博客&笔记"], "拉丁在前、中文在后(资源管理器口径)");
	assert.deepEqual(rows.map((r) => r.name), ["博客&笔记", "ais", "Zed 面板汉化"], "原数组不能被改");
});

test("sortRows:中文按拼音排(博客 < 大四 < 会话)", () => {
	const rows = [view("会话记录"), view("大四上课程"), view("博客&笔记")];
	assert.deepEqual(sortRows(rows, "alpha").map((r) => r.name), ["博客&笔记", "大四上课程", "会话记录"]);
});

test("sortRows:数字按大小排(会话 2 在 会话 10 前面)", () => {
	const rows = [view("会话 10"), view("会话 2")];
	assert.deepEqual(sortRows(rows, "alpha").map((r) => r.name), ["会话 2", "会话 10"]);
});

test("sortRows:大小写不敏感(AIS 与 ais 相邻,不会被 ASCII 码点拆开)", () => {
	const rows = [view("beta"), view("AIS"), view("ais")];
	const names = sortRows(rows, "alpha").map((r) => r.name);
	assert.deepEqual(names.slice(0, 2).sort(), ["AIS", "ais"], "同名的两种大小写应当挨着");
});

test("sortRows:同名不同工具时按工具、再按最近活跃(顺序稳定)", () => {
	const rows = [view("会话", { tool: "pi", updated: 100 }), view("会话", { tool: "claude", updated: 200 }), view("会话", { tool: "pi", updated: 300 })];
	const sorted = sortRows(rows, "alpha");
	assert.deepEqual(sorted.map((r) => `${r.tool}:${r.updatedAt.getTime()}`), ["claude:200", "pi:300", "pi:100"]);
});

test("sortBucket:数字 0 / 拉丁 1 / 中文 2 / 其它 3", () => {
	assert.equal(sortBucket("4-1-大学物理"), 0);
	assert.equal(sortBucket("ais"), 1);
	assert.equal(sortBucket("AIS"), 1);
	assert.equal(sortBucket("博客&笔记"), 2);
	assert.equal(sortBucket("★ 收藏"), 3);
	assert.equal(sortBucket(""), 3);
});

test("sortName:name 优先,退回 topic,最后用 id 前缀", () => {
	assert.equal(sortName(view("名字", { topic: "话题" })), "名字");
	assert.equal(sortName({ ...view(""), topic: "话题" }), "话题");
	assert.equal(sortName({ ...view(""), topic: "", id: "abcdefgh123" }), "abcdefgh");
});
