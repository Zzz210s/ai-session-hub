import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePreflightShell, startPreflight } from "../src/preflight-run.ts";
import { readPreflightState, stateFilePath, writePreflightState } from "../src/preflight-ttl.ts";

/** 没有 Git Bash 就排不出步骤(startPreflight 会直接返回 undefined),这类用例跳过 */
const noShell = !resolvePreflightShell();

function sandbox() {
	const home = mkdtempSync(join(tmpdir(), "ais-start-"));
	const saved = { home: process.env.AIS_HOME, ttl: process.env.AIS_UPDATE_TTL, off: process.env.AIS_NO_UPDATE };
	process.env.AIS_HOME = home;
	delete process.env.AIS_UPDATE_TTL;
	delete process.env.AIS_NO_UPDATE;
	return {
		home,
		restore() {
			for (const [key, value] of [["AIS_HOME", saved.home], ["AIS_UPDATE_TTL", saved.ttl], ["AIS_NO_UPDATE", saved.off]]) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		},
	};
}


/**
 * 隔离的扩展世界:临时 settings + npm/package.json + 已装版本,配一个假 registry。
 *
 * 为什么要它:预检会去查真实 `~/.pi/agent`(那里有 10 个真扩展)和真实 registry ——
 * 用例会变成"依赖本机状态 + 每次 4-20 秒"。注入之后既快又确定。
 */
function extWorld(dir, versions = { "pi-a": "1.0.0" }) {
	mkdirSync(join(dir, "npm", "node_modules"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: Object.keys(versions).map((n) => `npm:${n}`) }), "utf8");
	writeFileSync(join(dir, "npm", "package.json"), JSON.stringify({ dependencies: Object.fromEntries(Object.keys(versions).map((n) => [n, "^1.0.0"])) }), "utf8");
	for (const [name, version] of Object.entries(versions)) {
		const dirPath = join(dir, "npm", "node_modules", ...name.split("/"));
		mkdirSync(dirPath, { recursive: true });
		writeFileSync(join(dirPath, "package.json"), JSON.stringify({ name, version }), "utf8");
	}
	return {
		settingsPath: join(dir, "settings.json"),
		extensionsRoot: join(dir, "npm", "node_modules"),
		manifestPath: join(dir, "npm", "package.json"),
	};
}

/** 假 registry:所有包都报同一个版本(默认与已装一致 = 已是最新) */
function fakeRegistry(versions) {
	return async (url) => {
		const name = decodeURIComponent(String(url).split("/").pop());
		const version = versions[name];
		return { ok: version !== undefined, json: async () => ({ "dist-tags": { latest: version } }) };
	};
}

/** 一套完整的注入参数:pi/claude 报"未知"(不跳过),扩展按 versions 判 */
function isolated(box, latest) {
	const paths = extWorld(join(box.home, "ext"));
	return {
		...paths,
		runner: offlineRunner,
		fetchImpl: fakeRegistry(latest),
		// GUI 应用版本读取真跑要 3 秒(Git Bash + PowerShell),用例里给个空表
		readVersions: async () => ({}),
	};
}

/** 假 runner:DSH 探测走它,一律回"没装",不碰网络 */
const offlineRunner = async () => ({ ok: false, out: "" });
const okPreflight = async (options) => ({ steps: options.steps.map((s) => ({ label: s.label, ok: true })), summary: `${options.steps.length} 步全部完成` });
const badPreflight = async (options) => ({
	steps: options.steps.map((s, i) => ({ label: s.label, ok: i !== 0, detail: i === 0 ? "boom" : undefined })),
	summary: `${options.steps.length - 1}/${options.steps.length} 步完成,失败: ${options.steps[0].label}`,
});

test("startPreflight:全部成功才写时间戳", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const line = await startPreflight({ ...isolated(box, { "pi-a": "1.0.0" }), runPreflight: okPreflight });
		assert.match(String(line), /全部成功/, "摘要应报告全部成功");
		const state = readPreflightState(stateFilePath());
		assert.equal(typeof state.lastSuccessAt, "number", "成功必须写时间戳,否则 TTL 永远不生效");
	} finally {
		box.restore();
	}
});

test("startPreflight:任一步失败不写时间戳(下次启动立刻重试)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const line = await startPreflight({ ...isolated(box, { "pi-a": "1.0.0" }), runPreflight: badPreflight });
		assert.doesNotMatch(String(line), /全部成功/);
		assert.equal(readPreflightState(stateFilePath()).lastSuccessAt, undefined, "失败绝不能写时间戳 —— 否则会被 TTL 挡住,坏状态一直留着");
		assert.equal(existsSync(stateFilePath()), false);
	} finally {
		box.restore();
	}
});

test("startPreflight:TTL 内直接跳过,不执行任何命令", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		writePreflightState(stateFilePath(), Date.now() - 60_000);
		let ran = 0;
		const line = await startPreflight({
			runner: async () => {
				ran += 1;
				return { ok: false, out: "" };
			},
			runPreflight: async () => {
				ran += 1;
				return { steps: [], summary: "should not run" };
			},
		});
		assert.match(String(line), /前检查过,跳过/);
		assert.equal(ran, 0, "跳过时不该执行任何命令(连 DSH 探测都不该跑)");
	} finally {
		box.restore();
	}
});

test("startPreflight:AIS_UPDATE_TTL=0 时 TTL 内也照跑", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		process.env.AIS_UPDATE_TTL = "0";
		writePreflightState(stateFilePath(), Date.now() - 60_000);
		let ran = 0;
		const line = await startPreflight({
			...isolated(box, { "pi-a": "1.0.0" }),
			runPreflight: async (options) => {
				ran += 1;
				return okPreflight(options);
			},
		});
		assert.equal(ran, 1, "AIS_UPDATE_TTL=0 必须每次都跑");
		assert.match(String(line), /全部成功/);
	} finally {
		box.restore();
	}
});

test("startPreflight:AIS_NO_UPDATE=1 静默跳过(连跳过行都不打印)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		process.env.AIS_NO_UPDATE = "1";
		let ran = 0;
		const line = await startPreflight({
			runner: async () => {
				ran += 1;
				return { ok: false, out: "" };
			},
			runPreflight: async () => {
				ran += 1;
				return { steps: [], summary: "" };
			},
		});
		assert.equal(line, undefined);
		assert.equal(ran, 0);
	} finally {
		box.restore();
	}
});

test("startPreflight:成功后的第二次启动被 TTL 挡住", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const injection = isolated(box, { "pi-a": "1.0.0" });
		await startPreflight({ ...injection, runPreflight: okPreflight });
		const second = await startPreflight({ ...injection, runPreflight: badPreflight });
		assert.match(String(second), /前检查过,跳过/, "第二次应被 TTL 挡住,而不是又跑一遍(还失败)");
	} finally {
		box.restore();
	}
});

test("startPreflight:更新命令报成功、扩展却没升级时,不算成功也不写时间戳", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		// registry 说 pi-a 有 1.1.0,但"更新"之后磁盘上还是 1.0.0
		// (= pi update --extensions 的已知静默路径:npm 解析到过期元数据,装上旧版本却不报错)
		const line = await startPreflight({ ...isolated(box, { "pi-a": "1.1.0" }), runPreflight: okPreflight });
		assert.doesNotMatch(String(line), /全部成功/, "没真正升级就不能说全部成功");
		assert.match(String(line), /pi 扩展仍未更新.*pi-a 1\.0\.0→1\.1\.0/, "要说清是哪个包没更新,否则用户只看到 pi 自己的提示");
		assert.equal(readPreflightState(stateFilePath()).lastSuccessAt, undefined, "不写时间戳,下次启动才会立刻重试");
	} finally {
		box.restore();
	}
});

test("startPreflight:更新后版本到位则算成功(复核不该误杀)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const injection = isolated(box, { "pi-a": "1.1.0" });
		const line = await startPreflight({
			...injection,
			runPreflight: async (options) => {
				// 模拟 pi update --extensions 真的把 pi-a 升到 1.1.0
				const dirPath = join(injection.extensionsRoot, "pi-a");
				writeFileSync(join(dirPath, "package.json"), JSON.stringify({ name: "pi-a", version: "1.1.0" }), "utf8");
				return okPreflight(options);
			},
		});
		assert.match(String(line), /全部成功/);
		assert.equal(typeof readPreflightState(stateFilePath()).lastSuccessAt, "number");
	} finally {
		box.restore();
	}
});

test("startPreflight:复核连续 3 次没生效后认账(不再每轮白跑)", { skip: noShell }, async () => {
	const box = sandbox();
	try {
		const injection = isolated(box, { "pi-a": "1.1.0" }); // registry 说有新版,磁盘上一直是 1.0.0
		const first = await startPreflight({ ...injection, runPreflight: okPreflight });
		const second = await startPreflight({ ...injection, runPreflight: okPreflight });
		assert.match(String(first), /第 1\/3 次/, "第一次失败要说清还会重试");
		assert.match(String(second), /第 2\/3 次/);
		process.env.AIS_UPDATE_TTL = "6h";
		const third = await startPreflight({ ...injection, runPreflight: okPreflight });
		assert.match(String(third), /连续 3 次没生效/, "到上限要认账,并告诉用户怎么强制重试");
		assert.equal(typeof readPreflightState(stateFilePath()).lastSuccessAt, "number", "认账后写时间戳,否则每次启动都白跑十几秒");
		const fourth = await startPreflight({ ...injection, runPreflight: okPreflight });
		assert.match(String(fourth), /前检查过,跳过/, "之后被 TTL 挡住");
	} finally {
		box.restore();
	}
});
