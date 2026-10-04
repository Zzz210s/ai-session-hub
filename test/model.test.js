/**
 * 模型形态推断单测:确认 zed/dsh 归为 GUI,其余工具为 CLI。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { kindOf } from "../src/model.ts";

test("kindOf:zed/dsh 是 GUI,其余是 CLI", () => {
	assert.equal(kindOf("zed"), "gui");
	assert.equal(kindOf("dsh"), "gui");
	for (const tool of ["pi", "claude", "opencode"]) assert.equal(kindOf(tool), "cli");
});
