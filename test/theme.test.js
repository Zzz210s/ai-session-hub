import assert from "node:assert/strict";
import { test } from "node:test";
import * as theme from "../src/theme.ts";
import { NEUTRAL_COLOR, namedNameColor, supportsColor, toolColor, toolColorIndex } from "../src/theme.ts";

test("toolColorIndex:各工具用各自 CLI 的品牌色", () => {
	assert.equal(toolColorIndex("pi"), 109);      // pi accent #8abeb7
	assert.equal(toolColorIndex("claude"), 209);  // Anthropic 橙 #d97757
	assert.equal(toolColorIndex("opencode"), 216);// opencode primary #fab283
	assert.equal(toolColorIndex("codex"), 35);    // OpenAI 绿 #10a37f
});

test("toolColorIndex:未知工具用中性色", () => {
	assert.equal(toolColorIndex("something-new"), NEUTRAL_COLOR);
	assert.equal(toolColorIndex(""), NEUTRAL_COLOR);
});

test("toolColor:生成 256 色 SGR,关闭时为空", () => {
	assert.equal(toolColor("pi"), "\u001b[38;5;109m");
	assert.equal(toolColor("claude"), "\u001b[38;5;209m");
	assert.equal(toolColor("pi", false), "");
});

test("supportsColor:NO_COLOR / AIS_COLOR=0 / 非 TTY 都关闭", () => {
	assert.equal(supportsColor({}, true), true);
	assert.equal(supportsColor({}, false), false);
	assert.equal(supportsColor({ NO_COLOR: "1" }, true), false);
	assert.equal(supportsColor({ AIS_COLOR: "0" }, true), false);
	assert.equal(supportsColor({ NO_COLOR: "" }, true), true); // 空串视为未设置
});

test("namedNameColor:命名会话用亮黄色,可关闭", () => {
	const { namedNameColor, NAMED_NAME_COLOR } = theme;
	assert.equal(NAMED_NAME_COLOR, 11);
	assert.equal(namedNameColor(true), "\u001b[38;5;11m");
	assert.equal(namedNameColor(false), "");
});
