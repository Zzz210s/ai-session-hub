import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExtensionList, validateExtension } from "../src/extensions.ts";

test("resolveExtensionList:环境变量优先(逗号分隔,去空白)", () => {
	assert.deepEqual(resolveExtensionList({ env: "tui-panes, my-ext ", config: '{"extensions":["other"]}' }), ["tui-panes", "my-ext"]);
});

test("resolveExtensionList:无环境变量时读配置文件", () => {
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":["a","b"]}' }), ["a", "b"]);
});

test("resolveExtensionList:配置缺失/损坏/空数组时回退默认", () => {
	assert.deepEqual(resolveExtensionList({}), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ config: "{ 坏 JSON" }), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":[]}' }), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":[1,2]}' }), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ defaults: ["x"] }), ["x"]);
});

test("validateExtension:必须有非空 name", () => {
	assert.equal(validateExtension(null), null);
	assert.equal(validateExtension("tui-panes"), null);
	assert.equal(validateExtension({}), null);
	assert.equal(validateExtension({ name: "   " }), null);
	const ok = { name: "tui-panes" };
	assert.equal(validateExtension(ok)?.name, "tui-panes");
});

test("validateExtension:接受带可选钩子的拓展", () => {
	const extension = { name: "demo", hints: ["a"], bodyView: () => [], handleKey: () => true, dispose: () => {} };
	const validated = validateExtension(extension);
	assert.equal(validated?.name, "demo");
	assert.equal(typeof validated?.bodyView, "function");
});
