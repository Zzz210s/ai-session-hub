/**
 * Linux 实况探测的解析与判定(纯函数,在任意平台上都能跑)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPsRows, matchWmctrlApps, parsePsOutput, parseWmctrlOutput } from "../src/live/linux.ts";
import { toolFromProcessName } from "../src/live/gui.ts";
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

// 真实 `wmctrl -l -p` 是五列:<hwnd> <桌面号> <pid> <client machine> <窗口标题>。
// 第 2 列是桌面号(sticky 窗口为 -1),pid 在第 3 列;标题里没有主机名。
const WMCTRL_SAMPLE = [
	"0x03400007  0 12345 myhost proj - Zed",
	"0x0360000a -1 23456 myhost config-ai - DeepSeek Harness",
	"0x0380000b  0 34567 myhost Terminal",
	"",
].join("\n");

test("parseWmctrlOutput:五列格式,pid 取第 3 列、标题不含主机名,sticky 行(-1)也解析", () => {
	assert.deepEqual(parseWmctrlOutput(WMCTRL_SAMPLE), [
		{ hwnd: "0x03400007", pid: 12345, title: "proj - Zed" },
		{ hwnd: "0x0360000a", pid: 23456, title: "config-ai - DeepSeek Harness" },
		{ hwnd: "0x0380000b", pid: 34567, title: "Terminal" },
	]);
});

test("parseWmctrlOutput:空输出与乱行返回空数组", () => {
	assert.deepEqual(parseWmctrlOutput(""), []);
	assert.deepEqual(parseWmctrlOutput("garbage\n"), []);
});

test("matchWmctrlApps:按进程名(不是标题)判定,标题是 23652 也能认出 Zed", async () => {
	const windows = parseWmctrlOutput(
		"0x1 0 111 myhost 23652\n0x2 0 222 myhost 随便一个窗口\n0x3 0 333 myhost config-ai - DeepSeek Harness",
	);
	const names = { 111: "zed", 222: "explorer", 333: "deepseek-harness" };
	const apps = await matchWmctrlApps(windows, (pid) => names[pid]);
	assert.deepEqual(
		apps.map((a) => [a.tool, a.pid, a.title]),
		[
			["zed", 111, "23652"],
			["dsh", 333, "config-ai - DeepSeek Harness"],
		],
	);
});

test("matchWmctrlApps:同一 pid 的多个窗口按 pid 去重,只留第一条", async () => {
	const windows = parseWmctrlOutput("0x1 0 111 host a - Zed\n0x2 0 111 host b - Zed");
	const apps = await matchWmctrlApps(windows, () => "zed");
	assert.deepEqual(apps.map((a) => a.hwnd), ["0x1"]);
});

test("toolFromProcessName:宽松识别 zed / DeepSeek Harness 的常见 comm 形态", () => {
	assert.equal(toolFromProcessName("zed"), "zed");
	assert.equal(toolFromProcessName("ZED"), "zed");
	assert.equal(toolFromProcessName("DeepSeek Harness"), "dsh");
	assert.equal(toolFromProcessName("deepseek-harness"), "dsh");
	assert.equal(toolFromProcessName("explorer"), undefined);
});
