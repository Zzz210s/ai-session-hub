import assert from "node:assert/strict";
import { test } from "node:test";
import { cliAvailable, missingCliMessage, quoteForShell, resolveCliCommand, resumeCommand } from "../src/resume.ts";

const SESSION = String.raw`C:\Users\23652\.pi\agent\sessions\--F--0-SchoolWork-4-1-大学物理--\2026-09-18T03-12-27-718Z_01a0b280.jsonl`;

test("quoteForShell:bash / PowerShell 用单引号,cmd 才用双引号", () => {
	assert.equal(quoteForShell(SESSION, "bash"), `'${SESSION}'`);
	assert.equal(quoteForShell(SESSION, "powershell"), `'${SESSION}'`);
	assert.equal(quoteForShell(SESSION, "cmd"), `"${SESSION}"`);
	assert.equal(quoteForShell("a'b", "bash"), `'a'\\''b'`, "bash 里的单引号要转义");
	assert.equal(quoteForShell("a'b", "powershell"), `'a''b'`);
});

test("resumeCommand:pi 的会话路径用单引号包,整条命令里没有双引号", () => {
	// 双引号会被 Windows Terminal 再序列化时连累反斜杠:C:\Users\23652\.pi 变成 C:Users23652.pi,
	// pi 于是去开一个"盘符相对路径",报 EPERM
	const command = resumeCommand({ tool: "pi", id: "x", file: SESSION });
	assert.ok(!command.includes('"'), `不该出现双引号: ${command}`);
	assert.match(command, /--session 'C:\\Users\\23652/);
});

test("resumeCommand:缺会话文件时不拼出 undefined", () => {
	assert.equal(resumeCommand({ tool: "pi", id: "x", file: undefined }), "");
});

test("resumeCommand:claude / opencode 用会话 id,不做多余引号", () => {
	assert.match(resumeCommand({ tool: "claude", id: "abc-123" }), /--resume abc-123$/);
	assert.match(resumeCommand({ tool: "opencode", id: "ses_1" }), /--session ses_1$/);
	assert.equal(resumeCommand({ tool: "zed", id: "z" }), "");
});

/* ---------- 可执行文件检测(2026-11-22 报障:opencode 未安装,ais 仍开标签 → command not found 127) ---------- */

test("cliAvailable:本机的 pi / claude 能解析到 .CMD,opencode 没有安装", () => {
	// 这台机器上 opencode 确实没装(只有会话数据库),所以它必须被判为不可用
	assert.equal(cliAvailable("pi"), true, "pi 应能找到可执行文件");
	assert.ok(resolveCliCommand("pi").includes("/"), "应解析成绝对路径,而不是裸命令名");
	assert.equal(cliAvailable("opencode"), false, "opencode 未安装 → 不可用");
	assert.equal(resolveCliCommand("opencode"), "opencode", "解析不出路径时退回裸命令名(复制到别处还能用)");
});

test("missingCliMessage:说清没装、数据还在、给出三条出路,且不谎称已启动", () => {
	const text = missingCliMessage("opencode");
	assert.match(text, /没找到 opencode 可执行文件/);
	assert.ok(text.includes("~/.local/share/opencode"), "要说明会话数据还在哪");
	assert.match(text, /AIS_OPENCODE_BIN/, "给出覆盖路径的办法");
	assert.match(text, /按 C 复制命令/, "给出复制到别处执行的出路");
	assert.doesNotMatch(text, /已启动|已打开/, "没装就不能说成功");
});
