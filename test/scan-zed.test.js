import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { firstFolder, scanZedSessions } from "../src/scan/zed.ts";

async function makeDb(rows) {
	const dir = mkdtempSync(join(tmpdir(), "ais-zed-"));
	const dbPath = join(dir, "threads.db");
	const { DatabaseSync } = await import("node:sqlite"); // 测试文件是 ESM:用动态 import
	const db = new DatabaseSync(dbPath);
	db.exec(
		"CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)",
	);
	const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	for (const r of rows) insert.run(r.id, r.summary, r.updated_at, "zstd", Buffer.alloc(r.bytes ?? 10), r.parent_id, r.folder_paths, "0", r.created_at);
	db.close();
	return { dbPath, dir };
}

function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("scanZedSessions:标题/时间/项目/父线程/大小都映射出来", async () => {
	const { dbPath, dir } = await makeDb([
		{
			id: "t1",
			summary: "审查阶段一收尾",
			updated_at: "2026-09-03T12:57:57.162282600+00:00",
			created_at: "2026-09-03T12:44:59.550622300+00:00",
			folder_paths: "C:\\Users\\23652",
			parent_id: null,
			bytes: 87,
		},
		{
			id: "t2",
			summary: "子线程",
			updated_at: "2026-09-03T12:57:00.000000000+00:00",
			created_at: "2026-09-03T12:56:00.000000000+00:00",
			folder_paths: '["C:\\\\a","C:\\\\b"]',
			parent_id: "t1",
			bytes: 5,
		},
	]);
	try {
		const rows = await scanZedSessions(dbPath);
		assert.equal(rows.length, 2);
		const [first] = rows;
		assert.equal(first.tool, "zed");
		assert.equal(first.name, "审查阶段一收尾");
		assert.equal(first.named, false, "自动生成的 summary 不算用户命名");
		assert.equal(first.cwd, "C:\\Users\\23652");
		assert.equal(first.createdAt.toISOString(), "2026-09-03T12:44:59.550Z");
		assert.equal(first.sizeBytes, 87);
		assert.equal(rows[1].parentId, "t1");
		assert.equal(rows[1].cwd, "C:\\a", "JSON 数组取第一个");
	} finally {
		cleanup(dir);
	}
});

test("scanZedSessions:空摘要与非法时间按设计降级", async () => {
	const { dbPath, dir } = await makeDb([
		{ id: "t3", summary: "", updated_at: "not-a-time", created_at: null, folder_paths: "C:\\x", parent_id: null, bytes: 3 },
	]);
	try {
		const mtime = statSync(dbPath).mtime;
		const [row] = await scanZedSessions(dbPath);
		assert.equal(row.name, undefined);
		assert.equal(row.named, false);
		assert.equal(row.topic, "");
		assert.equal(row.updatedAt.getTime(), mtime.getTime(), "非法时间回落到文件 mtime");
		assert.notEqual(row.updatedAt.getTime(), 0, "不再落到 1970");
	} finally {
		cleanup(dir);
	}
});

test("firstFolder:非字符串首元素 / 空数组返回空串", () => {
	assert.equal(firstFolder('["C:\\\\a","C:\\\\b"]'), "C:\\a");
	assert.equal(firstFolder("[1,2]"), "");
	assert.equal(firstFolder("[]"), "");
	assert.equal(firstFolder("not-json["), "not-json[");
	assert.equal(firstFolder("C:\\Users\\23652"), "C:\\Users\\23652");
});

test("scanZedSessions:库不存在时返回空数组,不抛错", async () => {
	assert.deepEqual(await scanZedSessions(join(tmpdir(), "ais-zed-missing", "threads.db")), []);
});
