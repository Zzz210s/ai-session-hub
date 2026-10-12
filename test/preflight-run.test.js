/**
 * 更新步骤组装单测(纯逻辑,离线):
 *  - 没有 Git Bash 就不排步骤(避免半套)
 *  - pi 本体 + 扩展两步恒在
 *  - 其它 CLI 只在装了时排,并且"尽力而为"(失败不阻断启动)
 *  - resolvePi 必须优先新版 pnpm 布局(旧 shim 指向旧版本,曾让会话跑旧 pi)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isInstalled, piUpdateCommand, planDshCliSteps, planUpdateSteps, resolvePi } from "../src/preflight-run.ts";

const BASH = "C:/Program Files/Git/bin/bash.exe";

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv(key, value, body) {
	const previous = process.env[key];
	process.env[key] = value;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
}

test("没有 Git Bash 时不排任何步骤", { skip: process.platform !== "win32" }, () => {
	assert.deepEqual(planUpdateSteps({ piBin: "C:/x/pi.CMD" }), []);
});

test("pi 本体与扩展恒在,且都经 Git Bash 执行", () => {
	const steps = planUpdateSteps({ piBin: "C:/x/pi.CMD", gitBash: BASH });
	assert.ok(steps.length >= 2);
	assert.equal(steps[0].label, "更新 pi 本体");
	for (const step of steps.slice(0, 3)) {
		assert.equal(step.command, BASH, "必须走 Git Bash(裸 bash 可能落到 WSL)");
		assert.equal(step.args[0], "-lc");
		assert.match(step.args[1], /"C:\/x\/pi\.CMD"|pnpm install -g/, "pi 路径要加引号");
	}
});

test("pi 三步:更新本体 -> 校验可执行 -> 更新扩展(校验紧跟安装)", () => {
	const steps = planUpdateSteps({ piBin: "C:/x/pi.CMD", gitBash: BASH });
	assert.deepEqual(
		steps.slice(0, 3).map((step) => step.label),
		["更新 pi 本体", "校验 pi 可执行", "更新 pi 扩展"],
	);
	assert.doesNotMatch(steps[1].args[1], /\|\| true$/, "校验必须是严格步骤:坏了要拦住 TTL 与提示");
});

test("预检说已是最新时,对应步骤真的被跳过", () => {
	const all = planUpdateSteps({ piBin: "C:/x/pi.CMD", gitBash: BASH }).map((step) => step.label);
	const labels = (skip) => planUpdateSteps({ piBin: "C:/x/pi.CMD", gitBash: BASH, skip }).map((step) => step.label);
	assert.deepEqual(
		labels({ pi: true }),
		all.filter((l) => l !== "更新 pi 本体" && l !== "校验 pi 可执行"),
		"跳过本体时校验也一起跳(没装东西就没什么可坏)",
	);
	assert.ok(!labels({ extensions: true }).includes("更新 pi 扩展"));
	assert.ok(labels({ claude: true }).includes("更新 Claude 插件"), "只跳本体,插件更新照跑");
	assert.ok(!labels({ claude: true }).includes("更新 Claude Code"));
});

test("piUpdateCommand:pnpm 装法交给包管理器,不让 pi 自己替换自己", () => {
	// 2026-10-08 事故:pi update 在自己运行中替换依赖树,Windows 上原生模块被锁 → 全局安装损坏
	const pnpm = piUpdateCommand("C:/Users/x/AppData/Local/pnpm/bin/pi.CMD");
	assert.equal(pnpm, "pnpm install -g --ignore-scripts --config.minimumReleaseAge=0 @earendil-works/pi-coding-agent@latest");
	const npmGlobal = piUpdateCommand("C:/Users/x/AppData/Roaming/npm/pi.CMD");
	assert.match(npmGlobal, /^npm install -g --ignore-scripts --min-release-age=0 /);
	assert.equal(piUpdateCommand("/usr/local/bin/pi"), '"' + "/usr/local/bin/pi" + '" update', "认不出装法就回落到 pi update");
});

test("其它 CLI 只在装了时排步骤,并带尽力而为后缀", { skip: process.platform !== "win32" }, () => {
	const dir = tempDir("ais-cli-");
	writeFileSync(join(dir, "claude.cmd"), "@echo off\n", "utf8");
	const steps = withEnv("APPDATA", dir, () => withEnv("PATH", dir, () => planUpdateSteps({ piBin: "pi", gitBash: BASH })));
	const labels = steps.map((step) => step.label);
	assert.ok(labels.includes("更新 Claude Code"), labels.join(","));
	assert.ok(labels.includes("更新 Claude 插件"));
	assert.ok(!labels.includes("更新 opencode"), "没装的 CLI 不应排步骤");
	const claude = steps.find((step) => step.label === "更新 Claude Code");
	assert.match(claude.args[1], /\|\| true$/, "尽力而为:失败不阻断启动");
	assert.doesNotMatch(steps[0].args[1], /\|\| true$/, "pi 本体是严格步骤");
});

test("resolvePi:新版 pnpm 布局优先于旧 shim", { skip: process.platform !== "win32" }, () => {
	const root = tempDir("ais-pi-");
	mkdirSync(join(root, "pnpm", "bin"), { recursive: true });
	writeFileSync(join(root, "pnpm", "pi.CMD"), "@echo off\n", "utf8"); // 旧 shim
	writeFileSync(join(root, "pnpm", "bin", "pi.CMD"), "@echo off\n", "utf8"); // 新布局
	const resolved = withEnv("LOCALAPPDATA", root, () => withEnv("APPDATA", "", () => resolvePi()));
	assert.equal(resolved.replace(/\\/g, "/"), join(root, "pnpm", "bin", "pi.CMD").replace(/\\/g, "/"));
});

test("resolvePi:都没有时回落到 PATH 上的 pi", { skip: process.platform !== "win32" }, () => {
	const empty = tempDir("ais-empty-");
	const resolved = withEnv("LOCALAPPDATA", empty, () => withEnv("APPDATA", empty, () => resolvePi()));
	assert.equal(resolved, "pi");
});

test("isInstalled:按 PATH 判定(Windows 看 .cmd,类 Unix 看无扩展名)", () => {
	const dir = mkdtempSync(join(tmpdir(), "ais-inst-"));
	const names = process.platform === "win32" ? ["claude.cmd"] : ["claude"];
	for (const name of names) writeFileSync(join(dir, name), "#!/bin/sh" + String.fromCharCode(10), "utf8");
	assert.equal(isInstalled("claude", { PATH: dir }), true);
	assert.equal(isInstalled("gemini", { PATH: dir }), false);
});

test("planUpdateSteps:类 Unix 上用 $SHELL 执行,步骤与 Windows 一致", () => {
	if (process.platform === "win32") return;
	const steps = planUpdateSteps({ piBin: "/usr/local/bin/pi", gitBash: "/bin/bash" });
	assert.ok(steps.length >= 2, "pi 本体与扩展恒在");
	assert.equal(steps[0].command, "/bin/bash");
	assert.match(steps[0].args[1], /"\/usr\/local\/bin\/pi" update/);
});

test("DSH CLI 步骤:文件系统判定装没装,装了才经 shell 排进 npm 组", () => {
	// 2026-10-12:判定改用文件系统(isInstalled),不再跑 `npm ls -g`(实测 2 秒)
	const missing = planDshCliSteps(true, BASH, false);
	assert.deepEqual(missing.steps, [], "没装 DSH CLI 就不排步骤");
	assert.equal(missing.status, "not-installed");
	const noNpm = planDshCliSteps(false, BASH, true);
	assert.deepEqual(noNpm.steps, [], "没装 npm 就不排步骤");
	assert.equal(noNpm.status, "npm-missing");

	const plan = planDshCliSteps(true, BASH, true);
	assert.equal(plan.status, "updated");
	assert.equal(plan.steps.length, 1);
	const step = plan.steps[0];
	assert.equal(step.label, "更新 DSH CLI");
	assert.equal(step.group, "npm");
	assert.notEqual(step.command, "npm", "必须经 shell:Windows 上裸 npm 会 ENOENT");
	assert.equal(step.command, BASH);
	assert.match(step.args[1], /\|\| true$/, "尽力而为:失败不拦启动");
});
