import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanDshSessions } from "../src/scan/dsh.ts";

const ID = "0691aeec-4482-4674-8a6d-2ed51504c079";
const DEFAULT_WS = "C:\\Users\\23652\\Documents\\deepseek-harness\\default-workspace";

function makeHome({ slug, workspaces, defaultWorkspaceId = "w1", workspaceFile = true }) {
	const home = mkdtempSync(join(tmpdir(), "ais-dsh-path-"));
	mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });
	writeFileSync(
		join(home, "storages", "session_projcache", "sessions", `${ID}.json`),
		JSON.stringify({ record: { rows: { title: { val: "t" }, sessionListMetadata: { val: { lastPromptAt: 1791092696504 } } } } }),
		"utf8",
	);
	if (workspaceFile) {
		writeFileSync(
			join(home, "storages", "workspace.json"),
			JSON.stringify({ global: { defaultWorkspaceId }, tables: { workspaces } }),
			"utf8",
		);
	}
	const sessionDir = join(home, "sessions", slug, ID);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.v4.jsonl.zstd"), Buffer.alloc(16), "utf8");
	return home;
}

function cleanup(home) {
	rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

test("cwd 门禁:decodeSlug 能解出字符串但路径不存在时不采用它", async () => {
	// --C-Users-me-my-app-- 反解得到 C:\Users\me\my\app,磁盘上并不存在
	const home = makeHome({ slug: "--C-Users-me-my-app--", workspaces: { w1: { path: DEFAULT_WS } } });
	try {
		const [row] = await scanDshSessions(home);
		assert.equal(row.cwd, DEFAULT_WS, "应退回默认工作区,而不是编造的路径");
		assert.notEqual(row.cwd, "C:\\Users\\me\\my\\app");
	} finally {
		cleanup(home);
	}
});

test("cwd 门禁:无 workspace.json 且反解路径不存在时退回空串", async () => {
	const home = makeHome({ slug: "--C-Users-me-my-app--", workspaces: {}, workspaceFile: false });
	try {
		const [row] = await scanDshSessions(home);
		assert.equal(row.cwd, "", "不应展示磁盘上不存在的编造路径");
	} finally {
		cleanup(home);
	}
});

test("encodeSlug 碰撞:两个工作区编码相同,先出现的路径不被覆盖", async () => {
	// C:\proj\a-b 与 C:\proj\a\b 都编码成 --C-proj-a-b--
	const home = makeHome({
		slug: "--C-proj-a-b--",
		workspaces: { w1: { path: "C:\\proj\\a-b" }, w2: { path: "C:\\proj\\a\\b" } },
	});
	try {
		const [row] = await scanDshSessions(home);
		assert.equal(row.cwd, "C:\\proj\\a-b", "先出现的工作区路径胜出");
		assert.notEqual(row.cwd, "C:\\proj\\a\\b", "不应被后写的同 slug 工作区污染");
	} finally {
		cleanup(home);
	}
});
