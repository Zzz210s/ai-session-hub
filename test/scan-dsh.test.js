import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeSlug, scanDshSessions } from "../src/scan/dsh.ts";

const SLUG = "--C-Users-23652-Documents-demo--";

function makeHome({ title = "config-ai", lastPromptAt = 1791092696504, archived = false } = {}) {
	const home = mkdtempSync(join(tmpdir(), "ais-dsh-"));
	const id = "0691aeec-4482-4674-8a6d-2ed51504c079";
	mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
	writeFileSync(
		join(home, "storages", "session_projcache", "sessions", `${id}.json`),
		JSON.stringify({
			record: {
				rows: {
					title: { val: title },
					sessionListMetadata: { val: { blank: false, lastPromptAt } },
					tokenUsage: { val: { totals: { uncachedInputTokens: 1853149, outputTokens: 491398 } } },
				},
			},
		}),
		"utf8",
	);
	writeFileSync(
		join(home, "storages", "workspace.json"),
		JSON.stringify({
			global: { archivedSessionIds: archived ? [id] : [], pinnedSessionIds: [], defaultWorkspaceId: "w1" },
			tables: { workspaces: { w1: { path: "C:\\Users\\23652\\Documents\\deepseek-harness\\default-workspace" } } },
		}),
		"utf8",
	);
	const sessionDir = join(home, "sessions", SLUG, id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), Buffer.alloc(4096), "utf8");
	return { home, id };
}

test("decodeSlug:把 DSH 的项目 slug 还原成路径", () => {
	assert.equal(decodeSlug(SLUG), "C:\\Users\\23652\\Documents\\demo");
	assert.equal(decodeSlug("nonsense"), undefined);
});

test("scanDshSessions:标题/活跃时间/归档/大小/元数据路径都映射出来", async () => {
	const { home, id } = makeHome({ archived: true });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		const [row] = rows;
		assert.equal(row.tool, "dsh");
		assert.equal(row.id, id);
		assert.equal(row.name, "config-ai");
		assert.equal(row.named, true);
		assert.equal(row.cwd, "C:\\Users\\23652\\Documents\\demo");
		assert.equal(row.updatedAt.toISOString(), new Date(1791092696504).toISOString());
		assert.equal(row.archived, true);
		assert.equal(row.sizeBytes, 4096);
		assert.match(row.metaFile ?? "", /session_projcache/);
		assert.match(row.file, /sessions/);
	} finally {
		rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("scanDshSessions:目录不存在时返回空数组", async () => {
	assert.deepEqual(await scanDshSessions(join(tmpdir(), "ais-dsh-missing")), []);
});

test("scanDshSessions:坏 JSON 只跳过那一条", async () => {
	const { home } = makeHome();
	try {
		writeFileSync(join(home, "storages", "session_projcache", "sessions", "broken.json"), "{ not json", "utf8");
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
	} finally {
		rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
