/**
 * 后台扫描:单飞、超时丢弃、错误降级,以及"真的能在 worker 里跑通"。
 *
 * 用假 worker 覆盖控制流(不必真起线程),再用一个临时会话目录做一次真 worker 集成测试。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resetBackgroundScan, scanInBackground } from "../src/scan/background.ts";
import { scanAllSessions } from "../src/scan/index.ts";

/** 假 worker:按脚本发消息/报错/退出 */
function fakeWorker(script) {
	const emitter = new EventEmitter();
	emitter.terminate = () => {
		emitter.terminated = true;
	};
	setImmediate(() => script(emitter));
	return emitter;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("scanInBackground:worker 回传记录时解析出结果并终止 worker", async () => {
	resetBackgroundScan();
	let created = 0;
	let terminated = false;
	const records = [{ tool: "pi", id: "a", name: "会话" }];
	const worker = {
		on(event, handler) {
			if (event === "message") setImmediate(() => handler({ ok: true, records }));
			return this;
		},
		terminate() {
			terminated = true;
		},
	};
	const result = await scanInBackground({
		spawn: () => {
			created++;
			return worker;
		},
	});
	assert.equal(created, 1);
	assert.deepEqual(result, records);
	assert.equal(terminated, true, "拿到结果后必须终止 worker,否则线程泄漏");
});

test("scanInBackground:worker 报错/提前退出 → undefined(调用方保留旧缓存)", async () => {
	resetBackgroundScan();
	const errorWorker = fakeWorker((w) => w.emit("error", new Error("boom")));
	assert.equal(await scanInBackground({ spawn: () => errorWorker }), undefined);

	resetBackgroundScan();
	const exitWorker = fakeWorker((w) => w.emit("exit", 1));
	assert.equal(await scanInBackground({ spawn: () => exitWorker }), undefined);

	resetBackgroundScan();
	assert.equal(
		await scanInBackground({
			spawn: () => {
				throw new Error("worker 起不来");
			},
		}),
		undefined,
		"起不来也不能抛错",
	);
});

test("scanInBackground:同一时刻只跑一个(第二个调用立刻返回 undefined)", async () => {
	resetBackgroundScan();
	let created = 0;
	const spawn = () => {
		created++;
		return fakeWorker(async (w) => {
			await sleep(30);
			w.emit("message", { ok: true, records: [] });
		});
	};
	const first = scanInBackground({ spawn });
	const second = await scanInBackground({ spawn });
	assert.equal(second, undefined, "在途时不该再起一个");
	assert.deepEqual(await first, []);
	assert.equal(created, 1);
	// 跑完之后可以再起
	const third = scanInBackground({ spawn });
	assert.deepEqual(await third, []);
	assert.equal(created, 2);
});

test("scanInBackground:在途超过卡死阈值就丢弃并允许重试", async () => {
	resetBackgroundScan();
	let created = 0;
	const spawn = () => {
		created++;
		return fakeWorker(() => {
			/* 永不回消息 = 卡死 */
		});
	};
	const clock = { t: 0 };
	const stuck = scanInBackground({ spawn, now: () => clock.t, stuckMs: 50 });
	clock.t += 20 * 60 * 1000; // 超过 SCAN_STUCK_MS
	const retry = scanInBackground({ spawn, now: () => clock.t, stuckMs: 50 });
	assert.equal(created, 2, "卡死后必须允许再起一个");
	assert.equal(await retry, undefined);
	assert.equal(await stuck, undefined, "卡死那次也要在超时后收尾,不能永远挂着");
});

test("真 worker:扫临时会话目录能拿回记录(Date 也要跨线程保住)", async () => {
	resetBackgroundScan();
	const root = mkdtempSync(join(tmpdir(), "ais-worker-"));
	const dir = join(root, "--C--fake--");
	mkdirSync(dir, { recursive: true });
	const stamp = "2026-10-04T00:00:00.000Z";
	writeFileSync(
		join(dir, `${stamp.replace(/[:.]/g, "-")}_01a00000-0000-7000-8000-000000000000.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id: "01a00000-0000-7000-8000-000000000000", timestamp: stamp, cwd: "C:/fake" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "第一条消息" }] } }),
			JSON.stringify({ type: "session_info", name: "worker 里的名字", timestamp: stamp }),
		].join(String.fromCharCode(10)) + String.fromCharCode(10),
		"utf8",
	);

	// 只扫 pi:不指定 tools 会连带去扫真实的 claude/opencode 存储(测试不该碰)
	const result = await scanInBackground({ tools: ["pi"], roots: { pi: root }, stuckMs: 60_000 });
	assert.ok(Array.isArray(result), "worker 必须回传数组");
	assert.equal(result.length, 1);
	assert.equal(result[0].name, "worker 里的名字");
	assert.ok(result[0].createdAt instanceof Date, "Date 要跨线程保住(不是字符串)");
	assert.equal(result[0].createdAt.toISOString(), stamp);
	// 同一个目录用进程内扫描也应当得到同样结果
	const inProcess = await scanAllSessions({ tools: ["pi"], roots: { pi: root } });
	assert.deepEqual(
		inProcess.map((r) => r.id),
		result.map((r) => r.id),
	);
});
