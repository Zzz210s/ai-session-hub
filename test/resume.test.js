import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteForShell, resumeCommand } from "../src/resume.ts";

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
