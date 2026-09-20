import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveShell, shellArgs, shellFlavor, shellPromptLabel } from "../src/shell.ts";

const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const WINDOWS_PS = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const PWSH = "C:/Program Files/PowerShell/7/pwsh.exe";
const CMD = "C:/Windows/System32/cmd.exe";

test("shellFlavor:识别 bash / PowerShell / cmd", () => {
	assert.equal(shellFlavor(GIT_BASH), "bash");
	assert.equal(shellFlavor(WINDOWS_PS), "powershell");
	assert.equal(shellFlavor(PWSH), "powershell");
	assert.equal(shellFlavor(CMD), "cmd");
});

test("resolveShell:AIS_SHELL 显式指定优先", () => {
	assert.equal(resolveShell({ AIS_SHELL: CMD }, () => false), CMD);
});

test("resolveShell:自动探测按 Git Bash → PowerShell 顺序", () => {
	const env = { ProgramFiles: "C:/PF", "ProgramFiles(x86)": "C:/PF86", SystemRoot: "C:/Windows" };
	assert.match(resolveShell(env, (path) => path.includes("Git")), /Git/);
	assert.match(resolveShell(env, (path) => path.includes("PowerShell")), /PowerShell/);
});

test("shellArgs:bash 传 -lc,PowerShell 传 -NoLogo -NoProfile -Command", () => {
	assert.deepEqual(shellArgs(GIT_BASH, "pi -p x").command, ["-lc", "pi -p x"]);
	const ps = shellArgs(WINDOWS_PS, "pi -p x");
	assert.deepEqual(ps.command, ["-NoLogo", "-NoProfile", "-Command", "pi -p x"]);
	assert.deepEqual(ps.interactive, ["-NoLogo", "-NoProfile"]);
});

test("shellArgs:keepAlive 时 bash 追加 exec、PowerShell 加 -NoExit", () => {
	assert.match(shellArgs(GIT_BASH, "cmd1", { keepAlive: true }).command[1], /exec/);
	assert.ok(shellArgs(PWSH, "cmd1", { keepAlive: true }).command.includes("-NoExit"));
});

test("shellArgs:cmd 形态", () => {
	assert.deepEqual(shellArgs(CMD, "dir").command, ["/d", "/s", "/c", "dir"]);
});

test("shellPromptLabel:展示用名称", () => {
	assert.equal(shellPromptLabel(GIT_BASH), "Git Bash");
	assert.equal(shellPromptLabel(PWSH), "PowerShell");
	assert.equal(shellPromptLabel(CMD), "cmd");
});
