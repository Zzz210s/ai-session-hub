import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSignature } from "../src/scan/signature.ts";

/** 所有来源指向不存在的路径,保证指纹只受本次临时目录里的内容影响(不读真实家目录) */
function hermetic(root, overrides = {}) {
	return {
		piSessions: join(root, "no-pi"),
		claudeProjects: join(root, "no-claude"),
		opencodeDb: join(root, "no-opencode.db"),
		zedDb: join(root, "no-zed.db"),
		dshProjcache: join(root, "no-projcache"),
		dshSessions: join(root, "no-dsh"),
		...overrides,
	};
}

test("sessionSignature:Zed 库内容变化(改名)会被板面感知", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-signature-zed-"));
	try {
		const zedDb = join(root, "threads.db");
		writeFileSync(zedDb, "a".repeat(64));
		const before = sessionSignature(hermetic(root, { zedDb }));
		writeFileSync(zedDb, "b".repeat(128));
		const after = sessionSignature(hermetic(root, { zedDb }));
		assert.notEqual(after, before, "库文件 size/mtime 变了,指纹必须变");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sessionSignature:DSH projcache 单文件内容变化会被板面感知", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-signature-dsh-"));
	try {
		const dir = join(root, "storages", "session_projcache", "sessions");
		mkdirSync(dir, { recursive: true });
		const meta = join(dir, "s1.json");
		writeFileSync(meta, '{"title":"a"}');
		const before = sessionSignature(hermetic(root, { dshProjcache: dir }));
		writeFileSync(meta, '{"title":"a much longer title"}');
		const after = sessionSignature(hermetic(root, { dshProjcache: dir }));
		assert.notEqual(after, before, "标题所在的元数据文件变了,指纹必须变");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("sessionSignature:Zed 库缺失时不报错(记 missing)", () => {
	const root = mkdtempSync(join(tmpdir(), "ais-signature-missing-"));
	try {
		assert.match(sessionSignature(hermetic(root)), /missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
