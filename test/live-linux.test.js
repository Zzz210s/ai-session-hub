/**
 * Linux 实况探测的解析与判定(纯函数,在任意平台上都能跑)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPsRows, parsePsOutput } from "../src/live/linux.ts";
import { classifyProcess } from "../src/live/classify.ts";

const PS_SAMPLE = `  101     1    3600 pts/3    /usr/bin/node /home/u/.local/share/pnpm/global/5/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --session a.jsonl
  102   101     120 pts/3    /usr/bin/node /home/u/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode json
  200     1    9000 ?        /usr/bin/node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js
  201     1     300 tty1     /usr/bin/opencode --session abc
  202     1      30 ?        /usr/bin/node /usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
    9     1    1000 pts/0    -bash
`;

test("parsePsOutput:按固定字段切开,命令行里的空格不影响", () => {
	const rows = parsePsOutput(PS_SAMPLE);
	assert.equal(rows.length, 6);
	assert.deepEqual(rows[0], {
		pid: 101,
		ppid: 1,
		elapsedSeconds: 3600,
		tty: "pts/3",
		args: "/usr/bin/node /home/u/.local/share/pnpm/global/5/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --session a.jsonl",
	});
	assert.equal(rows[2].tty, "?", "无终端的进程 tty 是 ?");
	assert.equal(rows[5].args, "-bash");
});

test("parsePsOutput:空行与乱码行直接跳过", () => {
	assert.deepEqual(parsePsOutput("\n  \nPID TTY CMD\n?? oops\n"), []);
});

test("classifyPsRows:识别 pi/claude/opencode,子代理标记为内部", () => {
	const now = Date.now();
	const processes = classifyPsRows(parsePsOutput(PS_SAMPLE), now);
	assert.deepEqual(
		processes.map((p) => [p.tool, p.pid, p.internal === true]),
		[
			["pi", 101, false],
			["pi", 102, true],
			["claude", 200, false],
			["opencode", 201, false],
			["pi", 202, false],
		],
		"bash 自身不算会话",
	);
	assert.equal(processes[0].startedAt.getTime(), now - 3600 * 1000, "按已运行秒数反推启动时间");
	assert.ok(processes[0].args.length <= 200, "args 截断到 200 字符");
});

test("classifyProcess:与 Windows 侧共用同一套判定", () => {
	assert.equal(classifyProcess("/usr/bin/node .../pi-coding-agent/dist/cli.js")?.tool, "pi");
	assert.equal(classifyProcess("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")?.tool, "claude");
	assert.equal(classifyProcess("/usr/bin/opencode")?.tool, "opencode");
	assert.equal(classifyProcess("/usr/bin/vim"), null);
});
