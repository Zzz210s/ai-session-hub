import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decodeSlug, scanDshSessions } from "../src/scan/dsh.ts";

const SLUG = "--C-Users-23652-Documents-demo--";
const ID = "0691aeec-4482-4674-8a6d-2ed51504c079";
const DEFAULT_WS = "C:\\Users\\23652\\Documents\\deepseek-harness\\default-workspace";
// workspace.json 的 path 编码后与真实会话目录名一致(连字符属于路径本身,反解会失真)
const WS_SLUG = "--C-Users-23652-Documents-deepseek-harness-default-workspace--";

function makeHome({
	title = "config-ai",
	lastPromptAt = 1791092696504,
	archived = false,
	pinned = false,
	body = true,
	workspace = true,
	slug = WS_SLUG,
} = {}) {
	const home = mkdtempSync(join(tmpdir(), "ais-dsh-"));
	const id = ID;
	mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
	writeFileSync(
		join(home, "storages", "session_projcache", "sessions", `${id}.json`),
		JSON.stringify({
			record: {
				rows: {
					title: { val: title },
					sessionListMetadata: { val: { blank: false, lastPromptAt } },
				},
			},
		}),
		"utf8",
	);
	if (workspace) {
		writeFileSync(
			join(home, "storages", "workspace.json"),
			JSON.stringify({
				global: {
					archivedSessionIds: archived ? [id] : [],
					pinnedSessionIds: pinned ? [id] : [],
					defaultWorkspaceId: "w1",
				},
				tables: { workspaces: { w1: { path: DEFAULT_WS } } },
			}),
			"utf8",
		);
	}
	if (body) {
		const sessionDir = join(home, "sessions", slug, id);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), Buffer.alloc(4096), "utf8");
	}
	return { home, id, bodyFile: join(home, "sessions", slug, id, "session.v4.jsonl.zstd") };
}

function cleanup(home) {
	rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("decodeSlug:把 DSH 的项目 slug 还原成路径", () => {
	assert.equal(decodeSlug(SLUG), "C:\\Users\\23652\\Documents\\demo");
	assert.equal(decodeSlug("nonsense"), undefined);
	// 形状合法但没有盘符
	assert.equal(decodeSlug("--Users-23652-demo--"), undefined);
});

test("scanDshSessions:用 workspace.json 的 path 编码匹配会话目录(路径含 - 也解对)", async () => {
	const { home } = makeHome();
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		// 反解会得到 deepseek/harness/default/workspace,权威清单匹配得到真实路径
		assert.equal(rows[0].cwd, DEFAULT_WS);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:slug 匹配不到 workspace.json 时回落默认工作区", async () => {
	// 没有盘符 -> decodeSlug 返回 undefined,只能回落默认工作区
	const { home } = makeHome({ slug: "--Users-23652-demo--" });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].cwd, DEFAULT_WS);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:标题/活跃时间/归档/置顶/大小/元数据路径都映射出来", async () => {
	const { home, id } = makeHome({ archived: true, pinned: true });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		const [row] = rows;
		assert.equal(row.tool, "dsh");
		assert.equal(row.id, id);
		assert.equal(row.name, "config-ai");
		assert.equal(row.named, false);
		assert.equal(row.cwd, DEFAULT_WS);
		assert.equal(row.updatedAt.toISOString(), new Date(1791092696504).toISOString());
		assert.equal(row.archived, true);
		assert.equal(row.pinned, true);
		assert.equal(row.sizeBytes, 4096);
		assert.match(row.metaFile ?? "", /session_projcache/);
		assert.match(row.file, /sessions/);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:仅有元数据、无正文目录时仍列出并回落到默认工作区", async () => {
	const { home, id } = makeHome({ body: false });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		const [row] = rows;
		assert.equal(row.id, id);
		assert.equal(row.file, "");
		assert.equal(row.cwd, DEFAULT_WS);
		assert.match(row.metaFile ?? "", /session_projcache/);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:空标题时 name 为 undefined、named 为 false", async () => {
	const { home } = makeHome({ title: "" });
	try {
		const [row] = await scanDshSessions(home);
		assert.equal(row.name, undefined);
		assert.equal(row.named, false);
		assert.equal(row.topic, "(未命名会话)");
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:非字符串标题只丢该字段,不丢整条会话", async () => {
	const { home } = makeHome({ title: 123 });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].name, undefined);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:非法时间戳回落到会话文件 mtime", async () => {
	const { home, bodyFile } = makeHome({ lastPromptAt: "not-a-number" });
	try {
		const [row] = await scanDshSessions(home);
		assert.ok(Number.isFinite(row.updatedAt.getTime()));
		assert.equal(row.updatedAt.getTime(), statSync(bodyFile).mtime.getTime());
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:workspace.json 缺失时 cwd 回落不抛错", async () => {
	const { home } = makeHome({ slug: "bogus-slug", workspace: false });
	try {
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].cwd, "");
		assert.equal(rows[0].archived, false);
	} finally {
		cleanup(home);
	}
});

test("scanDshSessions:目录不存在时返回空数组", async () => {
	const missing = mkdtempSync(join(tmpdir(), "ais-dsh-missing-"));
	rmSync(missing, { recursive: true, force: true });
	assert.deepEqual(await scanDshSessions(missing), []);
});

test("scanDshSessions:坏 JSON 只跳过那一条", async () => {
	const { home } = makeHome();
	try {
		writeFileSync(join(home, "storages", "session_projcache", "sessions", "broken.json"), "{ not json", "utf8");
		const rows = await scanDshSessions(home);
		assert.equal(rows.length, 1);
	} finally {
		cleanup(home);
	}
});
