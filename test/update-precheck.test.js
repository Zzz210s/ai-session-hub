/**
 * update-precheck.ts 的单测:全部离线(registry 用注入的 fetch,路径用临时目录)。
 * 这个模块决定"跳过哪些更新",判错会导致漏更新,所以每条判定都要有据。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	claudeInstalledVersion,
	extensionRefs,
	fetchLatestVersions,
	parsePackageEntry,
	precheckEnabled,
	precheckUpdates,
	readPkgVersion,
	verdictOf,
} from "../src/update-precheck.ts";

function tempDir(prefix = "ais-pre-") {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writePkg(dir, name, version) {
	const target = join(dir, ...name.split("/"));
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "package.json"), JSON.stringify({ name, version }), "utf8");
}

/** 假 registry:返回 dist-tags.latest;名字在 missing 里则返回 404 */
function fakeFetch(latest, missing = []) {
	return async (url) => {
		const name = decodeURIComponent(String(url).split("/").pop()).replace("%2F", "/");
		if (missing.includes(name)) return { ok: false, json: async () => ({}) };
		if (!(name in latest)) return { ok: false, json: async () => ({}) };
		return { ok: true, json: async () => ({ "dist-tags": { latest: latest[name] } }) };
	};
}

test("parsePackageEntry:取包名与 pin", () => {
	assert.deepEqual(parsePackageEntry("npm:pi-web-access"), { name: "pi-web-access" });
	assert.deepEqual(parsePackageEntry("npm:@scope/pkg@2.0.0"), { name: "@scope/pkg", pin: "2.0.0" });
	assert.deepEqual(parsePackageEntry("npm:@scope/pkg"), { name: "@scope/pkg" });
});

test("readPkgVersion:读到就返回,缺失/损坏返回 undefined", () => {
	const dir = tempDir();
	try {
		writePkg(dir, "a", "1.2.3");
		assert.equal(readPkgVersion(join(dir, "a", "package.json")), "1.2.3");
		assert.equal(readPkgVersion(join(dir, "nope", "package.json")), undefined);
		writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
		assert.equal(readPkgVersion(join(dir, "bad.json")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("extensionRefs:从 settings.json 读 packages,版本来自 node_modules", () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		writePkg(modules, "@s/pi-b", "2.0.0");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a", "npm:@s/pi-b@2.0.0", "npm:pi-missing"] }), "utf8");
		const refs = extensionRefs(settings, modules);
		assert.deepEqual(refs, [
			{ name: "pi-a", installed: "1.0.0", pin: undefined },
			{ name: "@s/pi-b", installed: "2.0.0", pin: "2.0.0" },
			{ name: "pi-missing", installed: undefined, pin: undefined },
		]);
		assert.deepEqual(extensionRefs(join(dir, "none.json"), modules), [], "读不到 settings 时返回空,不抛");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("verdictOf:全一致才是 up-to-date,信息缺失一律 unknown", () => {
	const latest = new Map([
		["a", "1.0.0"],
		["b", "2.0.0"],
		["c", "9.9.9"],
	]);
	assert.equal(verdictOf([{ name: "a", installed: "1.0.0" }], latest), "up-to-date");
	assert.equal(verdictOf([{ name: "a", installed: "1.0.0" }, { name: "b", installed: "1.9.0" }], latest), "outdated");
	assert.equal(verdictOf([{ name: "a", installed: "1.0.0" }, { name: "z" }], latest), "unknown", "查不到 latest 就未知");
	assert.equal(verdictOf([{ name: "a" }], latest), "unknown", "本地版本读不到就未知");
	assert.equal(verdictOf([], latest), "unknown");
	assert.equal(
		verdictOf([{ name: "c", installed: "1.0.0", pin: "1.0.0" }], latest),
		"up-to-date",
		"有 pin 时只比 pin(上游有新版也不触发更新,因为 --extensions 会尊重 pin)",
	);
});

test("fetchLatestVersions:并行查,失败的包不进结果", async () => {
	const map = await fetchLatestVersions(["a", "b", "c"], { fetchImpl: fakeFetch({ a: "1.0.0", b: "2.0.0" }, ["c"]) });
	assert.equal(map.get("a"), "1.0.0");
	assert.equal(map.get("b"), "2.0.0");
	assert.equal(map.has("c"), false, "404/失败 -> 该包未知");
});

test("precheckUpdates:三类都最新 -> 全部 up-to-date 且给出跳过说明", async () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");
		const appdata = join(dir, "appdata");
		writePkg(join(appdata, "npm", "node_modules"), "@anthropic-ai/claude-code", "3.0.0");

		const result = await precheckUpdates({
			piVersion: async () => "1.1.0",
			settingsPath: settings,
			extensionsRoot: modules,
			env: { APPDATA: appdata },
			fetchImpl: fakeFetch({ "@earendil-works/pi-coding-agent": "1.1.0", "@anthropic-ai/claude-code": "3.0.0", "pi-a": "1.0.0" }),
		});
		assert.deepEqual([result.pi, result.extensions, result.claude], ["up-to-date", "up-to-date", "up-to-date"]);
		assert.match(String(result.note), /已是最新,跳过: pi 本体 \/ pi 扩展 \/ Claude Code/);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("precheckUpdates:有新版 -> outdated;查不到 -> unknown(照旧更新)", async () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");

		const outdated = await precheckUpdates({
			piVersion: async () => "1.1.0",
			settingsPath: settings,
			extensionsRoot: modules,
			env: { APPDATA: join(dir, "none") },
			fetchImpl: fakeFetch({ "@earendil-works/pi-coding-agent": "1.2.0", "pi-a": "1.0.0" }),
		});
		assert.equal(outdated.pi, "outdated", "本地 1.1.0 vs 上游 1.2.0");
		assert.equal(outdated.extensions, "up-to-date");
		assert.equal(outdated.claude, "unknown", "claude 本地版本读不到");
		assert.match(String(outdated.note), /跳过: pi 扩展/);

		const offline = await precheckUpdates({
			piVersion: async () => "1.1.0",
			settingsPath: settings,
			extensionsRoot: modules,
			env: { APPDATA: join(dir, "none") },
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		assert.deepEqual([offline.pi, offline.extensions, offline.claude], ["unknown", "unknown", "unknown"], "断网 -> 全部 unknown -> 照旧更新");
		assert.equal(offline.note, undefined, "没有可跳过的项就不出说明");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("precheckUpdates:piVersion 抛错不影响整体(退成 unknown)", async () => {
	const dir = tempDir();
	try {
		const result = await precheckUpdates({
			piVersion: async () => {
				throw new Error("pi 起不来");
			},
			settingsPath: join(dir, "none.json"),
			extensionsRoot: join(dir, "none"),
			env: { APPDATA: join(dir, "none") },
			fetchImpl: fakeFetch({}),
		});
		assert.deepEqual([result.pi, result.extensions, result.claude], ["unknown", "unknown", "unknown"]);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("claudeInstalledVersion:按 APPDATA 找 npm 全局包", () => {
	const dir = tempDir();
	try {
		writePkg(join(dir, "npm", "node_modules"), "@anthropic-ai/claude-code", "9.9.9");
		assert.equal(claudeInstalledVersion({ APPDATA: dir }), "9.9.9");
		assert.equal(claudeInstalledVersion({ APPDATA: join(dir, "empty") }), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("precheckEnabled:AIS_UPDATE_PRECHECK=0 关闭,默认开", () => {
	assert.equal(precheckEnabled({}), true);
	assert.equal(precheckEnabled({ AIS_UPDATE_PRECHECK: "1" }), true);
	assert.equal(precheckEnabled({ AIS_UPDATE_PRECHECK: "0" }), false);
});

test("fetchLatestVersions:第一次失败会重试一次(registry 抽风不该导致整轮更新)", async () => {
	let calls = 0;
	const flaky = async (url) => {
		calls += 1;
		const name = decodeURIComponent(String(url).split("/").pop());
		if (calls <= 2) throw new Error("timeout"); // 前两次(含重试路径)失败
		return { ok: true, json: async () => ({ "dist-tags": { latest: name === "a" ? "1.0.0" : "2.0.0" } }) };
	};
	const map = await fetchLatestVersions(["a", "b"], { fetchImpl: flaky, timeoutMs: 10, retryTimeoutMs: 10 });
	assert.equal(calls >= 3, true, "必须发生重试");
	assert.equal(map.get("a"), "1.0.0", "重试成功要拿到版本");
	assert.equal(map.get("b"), "2.0.0");
});

test("fetchLatestVersions:两次都失败才认输(该包 unknown)", async () => {
	let calls = 0;
	const dead = async () => {
		calls += 1;
		throw new Error("network down");
	};
	const map = await fetchLatestVersions(["a"], { fetchImpl: dead, timeoutMs: 10, retryTimeoutMs: 10 });
	assert.equal(map.size, 0);
	assert.equal(calls, 2, "每个包最多试两次(不无限重试)");
});
