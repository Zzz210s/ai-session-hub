import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefreshAction, createSortToggle } from "../src/tui-wiring.ts";

test("createSortToggle:循环切换、光标回顶、写盘、提示都做到", () => {
	let mode = "default";
	let cursor = 5;
	const messages = [];
	const persisted = [];
	let redraws = 0;
	const toggle = createSortToggle({
		get: () => mode,
		set: (next) => (mode = next),
		resetCursor: () => (cursor = 0),
		notify: (text) => messages.push(text),
		redraw: () => (redraws += 1),
		persist: (next) => persisted.push(next),
	});

	toggle();
	assert.equal(mode, "alpha", "第一次按 s 切到字母序");
	assert.equal(cursor, 0, "顺序变了,光标要回顶部");
	assert.deepEqual(persisted, ["alpha"], "选择要写进配置,下次启动仍是这个顺序");
	assert.deepEqual(messages, ["排序:字母"], "状态行说清当前排序");
	assert.equal(redraws, 1, "切完要立刻重绘");

	toggle();
	assert.equal(mode, "created", "第二次按 S 切到创建顺序");
	assert.equal(messages.at(-1), "排序:创建顺序");

	toggle();
	assert.equal(mode, "default", "第三次回到运行日期");
	assert.deepEqual(persisted, ["alpha", "created", "default"], "每次切换都要写盘");
	assert.equal(messages.at(-1), "排序:运行日期", "默认排序对外叫「运行日期」");
});

test("createRefreshAction:清缓存 → 重扫 → 重绘,清缓存失败也继续重扫", async () => {
	const order = [];
	const refresh = createRefreshAction({
		clear: async () => {
			order.push("clear");
			throw new Error("临时目录被占用");
		},
		reload: async () => void order.push("reload"),
		notify: (text) => order.push(`notify:${text}`),
		redraw: () => void order.push("redraw"),
	});
	await refresh();
	assert.deepEqual(order, ["notify:强制刷新中(清缓存)…", "clear", "reload", "redraw"], "清缓存抛错不能挡住重扫");
});
