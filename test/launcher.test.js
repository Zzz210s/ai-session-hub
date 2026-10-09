/**
 * 启动器必须跨机器通用,并且满足 Windows 的两条编码约束(2026-10-09 两次真实踩坑):
 *  - .cmd 会被 cmd.exe 按 OEM 代码页(中文机器上是 GBK)读,含 UTF-8 中文直接解析失败
 *  - .ps1 无 BOM 时 Windows PowerShell 5.1 按 ANSI 读,中文乱码并断字符串终止符
 *  - 启动器里不该出现任何本机路径(盘符+用户名、本机目录名),否则换机器就坏
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const NAMES = ["ais", "ais.cmd", "ais.ps1"];
const readBytes = (name) => readFileSync(join(BIN, name));

test("启动器不含本机路径(用户名目录 / 本机工作目录)", () => {
	for (const name of NAMES) {
		const text = readBytes(name).toString("utf8");
		assert.doesNotMatch(text, /[A-Za-z]:[\\/]+Users[\\/]+[^%$]/i, name + " 里出现了本机用户绝对路径");
		assert.doesNotMatch(text, /0-code|0-Note|23652/, name + " 里出现了本机专有目录");
	}
});

test("ais.cmd 必须是纯 ASCII", () => {
	const bytes = readBytes("ais.cmd");
	const bad = [...bytes].findIndex((b) => b > 0x7f);
	assert.equal(bad, -1, "ais.cmd 第 " + bad + " 字节非 ASCII,中文机器上会解析失败");
});

test("ais.ps1 必须带 UTF-8 BOM", () => {
	assert.deepEqual([...readBytes("ais.ps1").subarray(0, 3)], [0xef, 0xbb, 0xbf], "缺 BOM:PowerShell 5.1 会按 ANSI 读");
});

test("三个启动器都按 ais.path 解析仓库位置", () => {
	for (const name of NAMES) {
		assert.match(readBytes(name).toString("utf8"), /ais\.path/, name + " 应读取同目录的 ais.path");
	}
});
