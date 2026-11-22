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

/** 临时改环境变量(测试之间互不影响) */
function withEnv(patch, body) {
	const saved = {};
	for (const key of Object.keys(patch)) {
		saved[key] = process.env[key];
		process.env[key] = patch[key];
	}
	try {
		return body();
	} finally {
		for (const key of Object.keys(patch)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

test("resolveCliCommand:pi / claude 解析成绝对路径(而不是裸命令名)", () => {
	assert.ok(resolveCliCommand("pi").includes("/"), "pi 应是绝对路径");
	assert.ok(resolveCliCommand("claude").includes("/"), "claude 应是绝对路径");
});

test("resolveCliCommand:AIS_<TOOL>_BIN 指哪打哪(cliAvailable 跟着走)", () => {
	const bogus = "C:/definitely/not/here/opencode.exe";
	withEnv({ AIS_OPENCODE_BIN: bogus }, () => {
		assert.equal(resolveCliCommand("opencode"), bogus, "显式覆盖优先");
		assert.equal(cliAvailable("opencode"), false, "路径不存在就是不可用");
	});
	// 指到本文件自己(任何真实文件都行,这里借 node 可执行)
	withEnv({ AIS_OPENCODE_BIN: process.execPath }, () => {
		assert.equal(cliAvailable("opencode"), true, "指向真实文件即可用");
	});
});

test("cliAvailable:目录同名不算可用(existsSync 会通过,但跑不起来)", () => {
	withEnv({ AIS_OPENCODE_BIN: "C:/Windows" }, () => {
		assert.equal(cliAvailable("opencode"), false, "目录不能被当成可执行文件");
	});
});

test("missingCliMessage:说清没装、数据还在、给出三条出路,且不谎称已启动", () => {
	const text = missingCliMessage("opencode");
	assert.match(text, /没找到 opencode 可执行文件/);
	assert.ok(text.includes("~/.local/share/opencode"), "要说明会话数据还在哪");
	assert.match(text, /AIS_OPENCODE_BIN/, "给出覆盖路径的办法");
	assert.match(text, /按 C 复制命令/, "给出复制到别处执行的出路");
	assert.doesNotMatch(text, /已启动|已打开/, "没装就不能说成功");
});
