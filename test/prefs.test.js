import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSortMode, writeSortMode } from "../src/prefs.ts";

const tempPath = () => join(mkdtempSync(join(tmpdir(), "ais-prefs-")), "config.json");

test("readSortMode:文件不存在 / 损坏 / 没有 ui 段一律当默认", () => {
	assert.equal(readSortMode(tempPath()), "default", "文件不存在");
	const broken = tempPath();
	writeFileSync(broken, "{不是 json");
	assert.equal(readSortMode(broken), "default", "损坏的 JSON");
	const empty = tempPath();
	writeFileSync(empty, JSON.stringify({ open: { mode: "tab" } }));
	assert.equal(readSortMode(empty), "default", "没有 ui 段");
});

test("readSortMode:读回写下的值", () => {
	const path = tempPath();
	writeSortMode("alpha", path);
	assert.equal(readSortMode(path), "alpha");
	writeSortMode("default", path);
	assert.equal(readSortMode(path), "default");
});

test("writeSortMode:保留文件里其它键(open 段不能被写坏)", () => {
	const path = tempPath();
	writeFileSync(path, JSON.stringify({ open: { mode: "window", keepFocus: false }, custom: 42 }, null, 2));
	writeSortMode("alpha", path);
	const raw = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(raw.open.mode, "window", "open 段原样保留");
	assert.equal(raw.open.keepFocus, false);
	assert.equal(raw.custom, 42, "不认识的键也不能丢");
	assert.equal(raw.ui.sort, "alpha", "只新增/改写 ui.sort");
});

test("writeSortMode:ui 段里别的键也保留", () => {
	const path = tempPath();
	writeFileSync(path, JSON.stringify({ ui: { density: "compact" } }));
	writeSortMode("alpha", path);
	const raw = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(raw.ui.density, "compact");
	assert.equal(raw.ui.sort, "alpha");
});

test("writeSortMode:文件不是 JSON 时从空对象开始写,不抛异常", () => {
	const path = tempPath();
	writeFileSync(path, "垃圾内容");
	assert.doesNotThrow(() => writeSortMode("alpha", path));
	assert.equal(JSON.parse(readFileSync(path, "utf8")).ui.sort, "alpha");
});
