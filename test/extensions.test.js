import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExtensionList, validateExtension } from "../src/extensions.ts";

test("resolveExtensionList:环境变量优先(逗号分隔,去空白)", () => {
	assert.deepEqual(resolveExtensionList({ env: "tui-panes, my-ext ", config: '{"extensions":["other"]}' }), ["tui-panes", "my-ext"]);
});

test("resolveExtensionList:无环境变量时读配置文件", () => {
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":["a","b"]}' }), ["a", "b"]);
});

test("resolveExtensionList:配置缺失/损坏时回退默认", () => {
	assert.deepEqual(resolveExtensionList({}), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ config: "{ 坏 JSON" }), ["tui-panes"]);
	assert.deepEqual(resolveExtensionList({ defaults: ["x"] }), ["x"]);
});

test("resolveExtensionList:显式空清单表示核心单独运行", () => {
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":[]}' }), []);
	assert.deepEqual(resolveExtensionList({ env: "none" }), []);
	assert.deepEqual(resolveExtensionList({ env: "none", config: '{"extensions":["a"]}' }), []);
});

test("resolveExtensionList:配置里的数组以它为准(过滤非字符串)", () => {
	assert.deepEqual(resolveExtensionList({ config: '{"extensions":["a",1,null,"b"]}' }), ["a", "b"]);
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
