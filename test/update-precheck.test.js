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
	defaultRefSources,
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

/* ---------- 覆盖全部受管扩展(2026-11-19 修「插件不完全更新」) ----------
 * 现场:pi 启动时提示 `@cortexkit/pi-magic-context`、`pi-subagents` 有更新;更关键的是
 * `@signalridge/pi-tab-status` 已装 1.2.2、上游 1.3.2,却**永远不更新** ——
 * 因为预检只看 settings.json 的 packages(9 个),而 pi 还会更新 ~/.pi/agent/npm/package.json
 * 里声明的那一个(共 10 个)。预检说"已是最新"→ 跳过 pi update --extensions → 它一直落后。
 */

test("extensionRefs:把 npm/package.json 里声明、但 settings 没列的扩展也算进来", () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		writePkg(modules, "@s/only-in-manifest", "1.2.2");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");
		const manifest = join(dir, "package.json");
		writeFileSync(
			manifest,
			JSON.stringify({ name: "pi-extensions", private: true, dependencies: { "pi-a": "^1.0.0", "@s/only-in-manifest": "^1.2.2" } }),
			"utf8",
		);
		const refs = extensionRefs(settings, modules, { manifestPath: manifest });
		assert.deepEqual(
			refs.map((r) => r.name).sort(),
			["@s/only-in-manifest", "pi-a"],
			"pi 会更新 package.json 里声明的所有依赖,预检必须一起看",
		);
		assert.equal(refs.find((r) => r.name === "@s/only-in-manifest").installed, "1.2.2");
		assert.equal(refs.find((r) => r.name === "@s/only-in-manifest").pin, undefined, "manifest 里的 ^1.2.2 是范围,不是 pin");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("extensionRefs:把工程作用域(<cwd>/.pi/agent/settings.json)的扩展也算进来", () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");
		const projectSettings = join(dir, "proj", ".pi", "agent", "settings.json");
		mkdirSync(join(dir, "proj", ".pi", "agent"), { recursive: true });
		writeFileSync(projectSettings, JSON.stringify({ packages: ["npm:pi-project-only"] }), "utf8");
		writePkg(join(dir, "proj", ".pi", "npm", "node_modules"), "pi-project-only", "2.0.0");

		const refs = extensionRefs(settings, modules, {
			projectSettingsPath: projectSettings,
			projectModulesRoot: join(dir, "proj", ".pi", "npm", "node_modules"),
		});
		assert.deepEqual(refs.map((r) => r.name).sort(), ["pi-a", "pi-project-only"]);
		assert.equal(refs.find((r) => r.name === "pi-project-only").installed, "2.0.0", "工程作用域的版本要从 .pi/npm 里读");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("precheckUpdates:只在受管清单里的孤儿落后时,不算落后,但要在提示里说出来", async () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		writePkg(modules, "@s/tab-status", "1.2.2");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");
		const manifest = join(dir, "package.json");
		writeFileSync(manifest, JSON.stringify({ dependencies: { "pi-a": "^1.0.0", "@s/tab-status": "^1.2.2" } }), "utf8");

		const result = await precheckUpdates({
			piVersion: async () => "1.1.0",
			settingsPath: settings,
			extensionsRoot: modules,
			manifestPath: manifest,
			env: { APPDATA: join(dir, "none") },
			fetchImpl: fakeFetch({ "@earendil-works/pi-coding-agent": "1.1.0", "pi-a": "1.0.0", "@s/tab-status": "1.3.2" }),
		});
		// pi update --extensions 只遍历 settings 的 packages(实测读源码 + 真机验证),孤儿它永远不更新。
		// 所以不能算进"该不该跑更新"的判断,否则每次启动都白跑十几秒;但要单独提示出来。
		assert.equal(result.extensions, "up-to-date", "孤儿不该让判定永远停在 outdated");
		assert.equal(result.orphans?.length, 1, "孤儿要在提示里列出来,让用户知道它不会自动更新");
		assert.equal(result.orphans[0].name, "@s/tab-status");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("precheckUpdates:工程作用域的扩展落后时判 outdated(pi 会更新它,不能跳过)", async () => {
	const dir = tempDir();
	try {
		const modules = join(dir, "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		const settings = join(dir, "settings.json");
		writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");
		const projectSettings = join(dir, "proj", ".pi", "agent", "settings.json");
		mkdirSync(join(dir, "proj", ".pi", "agent"), { recursive: true });
		writeFileSync(projectSettings, JSON.stringify({ packages: ["npm:pi-proj"] }), "utf8");
		writePkg(join(dir, "proj", ".pi", "npm", "node_modules"), "pi-proj", "1.0.0");

		const result = await precheckUpdates({
			piVersion: async () => "1.1.0",
			settingsPath: settings,
			extensionsRoot: modules,
			manifestPath: join(dir, "npm", "package.json"),
			projectSettingsPath: projectSettings,
			projectModulesRoot: join(dir, "proj", ".pi", "npm", "node_modules"),
			env: { APPDATA: join(dir, "none") },
			fetchImpl: fakeFetch({ "@earendil-works/pi-coding-agent": "1.1.0", "pi-a": "1.0.0", "pi-proj": "1.2.0" }),
		});
		assert.equal(result.extensions, "outdated", "工程作用域的包 pi 也会更新,漏看就会跳过更新");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});

test("extensionRefs:在家目录里启动时,工程 settings 与全局是同一个文件(不能读错安装根)", () => {
	const dir = tempDir();
	try {
		const agentDir = join(dir, ".pi", "agent");
		const modules = join(agentDir, "npm", "node_modules");
		writePkg(modules, "pi-a", "1.0.0");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-a"] }), "utf8");

		// cwd = 家目录 -> projectSettingsPath 与 settingsPath 是同一个文件
		const sources = defaultRefSources(agentDir, dir);
		assert.equal(sources.projectSettingsPath, sources.settingsPath, "构造前提:两者确实同一路径");
		const refs = extensionRefs(sources.settingsPath, sources.modulesRoot, sources);
		assert.equal(refs[0].installed, "1.0.0", "必须从 npm/node_modules 读,不能因为工程路径相同就去 ~/.pi/npm 找");
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
