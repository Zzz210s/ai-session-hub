/**
 * 更新前的「有没有新版本」预检(2026-10-12,用户报「ais 启动过慢」)。
 *
 * 为什么要它:2026-10-08 另一会话把 pi 自更新从 `pi update`(实测 1.8s)改成
 * `pnpm install -g ...`(实测 9-28s,随网络与杀软波动)以避开 Windows 上替换运行中
 * `.node` 导致的全局安装损坏;`claude update` 又是 6.6s。于是**一次完整自更新从 13s
 * 涨到 37.5s**(实测:pnpm 安装 28.7s + pi 扩展 5.3s + claude 6.6s + claude 插件 6.3s),
 * 而绝大多数时候其实无事可做 —— 命令仍然要各自去 registry 走一趟。
 *
 * 做法:先花约 2-4 秒查一次「本地版本 vs registry latest」(10 个包并行一次请求),
 * 全部一致就**跳过对应的更新命令**。实测全绿时整段自更新 37.5s -> 约 4-6s。
 *
 * 与 2026-10-01「不要检测」决策的关系:那条针对的是**猜安装方式**(跨 pnpm/npm/原生
 * 易碎)。这里只比版本号,而且**失败即更新** —— 查不到、超时、解析失败一律按 unknown
 * 处理,照旧跑更新命令,所以检测失效不会导致漏更新,最坏只是回到原来的耗时。
 * 逃生舱:`AIS_UPDATE_PRECHECK=0` 恢复「每次都跑」。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 预检结论:一致 / 有新版本 / 未知(未知一律当作要更新) */
export type PrecheckVerdict = "up-to-date" | "outdated" | "unknown";

export interface PkgRef {
	/** npm 包名 */
	name: string;
	/** 本地已装版本(读不到则 undefined) */
	installed?: string;
	/** settings.json 里的固定版本(pin 存在时只比 pin,不去追 latest) */
	pin?: string;
}

export interface PrecheckResult {
	pi: PrecheckVerdict;
	extensions: PrecheckVerdict;
	claude: PrecheckVerdict;
	/** 摘要用的一句话,例如「已是最新: pi 本体 / pi 扩展」;没有跳过项时为 undefined */
	note?: string;
}

const REGISTRY = "https://registry.npmjs.org";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";

/** AIS_UPDATE_PRECHECK=0 关闭预检(恢复"每次都跑") */
export function precheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AIS_UPDATE_PRECHECK !== "0";
}

/** 读 package.json 的 version;任何异常都返回 undefined(→ unknown → 照旧更新) */
export function readPkgVersion(pkgJsonPath: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** 从 `npm:pkg@1.2.3` 这类 settings 条目里取包名与 pin */
export function parsePackageEntry(entry: string): { name: string; pin?: string } {
	const raw = entry.startsWith("npm:") ? entry.slice(4) : entry;
	const at = raw.lastIndexOf("@");
	if (at > 0) return { name: raw.slice(0, at), pin: raw.slice(at + 1) };
	return { name: raw };
}

/** 本地已装的 pi 扩展版本(直接读 node_modules 里的 package.json,毫秒级;`pi list` 要 5.5s) */
export function extensionRefs(settingsPath: string, modulesRoot: string): PkgRef[] {
	let packages: unknown;
	try {
		packages = (JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown }).packages;
	} catch {
		return [];
	}
	if (!Array.isArray(packages)) return [];
	return packages
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((entry) => {
			const { name, pin } = parsePackageEntry(entry);
			const installed = readPkgVersion(join(modulesRoot, ...name.split("/"), "package.json"));
			return { name, installed, pin };
		});
}

/** claude 的本地版本:npm 全局布局下直接读文件(实测 `claude --version` 要 5.1s) */
export function claudeInstalledVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const roots = [env.APPDATA ? join(env.APPDATA, "npm", "node_modules") : undefined, "/usr/local/lib/node_modules", join(homedir(), ".npm-global", "lib", "node_modules")];
	for (const root of roots) {
		if (!root) continue;
		const pkg = join(root, ...CLAUDE_PACKAGE.split("/"), "package.json");
		if (existsSync(pkg)) {
			const version = readPkgVersion(pkg);
			if (version) return version;
		}
	}
	return undefined;
}

/** 单个包查一次(带超时);拿不到 latest 返回 undefined */
async function fetchOne(doFetch: typeof fetch, registry: string, name: string, timeoutMs: number): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await doFetch(`${registry}/${name.replace("/", "%2F")}`, {
			headers: { Accept: "application/vnd.npm.install-v1+json" },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { "dist-tags"?: { latest?: unknown } };
		const latest = body["dist-tags"]?.latest;
		return typeof latest === "string" && latest.trim() ? latest.trim() : undefined;
	} catch {
		return undefined; // 超时/网络/解析失败 -> 该包未知
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 一次并行查所有包的 latest;单个失败只影响该包(→ unknown)。registry 可注入以便离线测试。
 *
 * 失败会**再试一次**并放宽超时:registry 偶尔会抽风(2026-10-12 实测一次连续超时 ~10s,
 * 随后立刻恢复正常)。不重试的话,抽风期间每个包都是 unknown —— 表现为"预检没帮上忙,
 * 又跑一遍 37-180 秒的完整更新",那正是要避免的。
 */
export async function fetchLatestVersions(
	names: string[],
	options: { fetchImpl?: typeof fetch; timeoutMs?: number; retryTimeoutMs?: number; registry?: string } = {},
): Promise<Map<string, string>> {
	const doFetch = options.fetchImpl ?? fetch;
	const registry = options.registry ?? REGISTRY;
	const timeoutMs = options.timeoutMs ?? 4_000;
	const retryTimeoutMs = options.retryTimeoutMs ?? Math.max(timeoutMs * 2, 8_000);
	const out = new Map<string, string>();
	await Promise.all(
		names.map(async (name) => {
			const first = await fetchOne(doFetch, registry, name, timeoutMs);
			if (first !== undefined) {
				out.set(name, first);
				return;
			}
			const second = await fetchOne(doFetch, registry, name, retryTimeoutMs);
			if (second !== undefined) out.set(name, second);
		}),
	);
	return out;
}

/**
 * 一组包的结论:全部一致 → up-to-date;有任一确定不一致 → outdated;其余 → unknown。
 * pin 存在时只与 pin 比(pi update --extensions 会尊重 pin,不该因为上游有新版就触发更新)。
 */
export function verdictOf(refs: PkgRef[], latest: Map<string, string>): PrecheckVerdict {
	if (refs.length === 0) return "unknown";
	let sawOutdated = false;
	for (const ref of refs) {
		const target = ref.pin ?? latest.get(ref.name);
		if (!ref.installed || !target) return "unknown";
		if (ref.installed !== target) sawOutdated = true;
	}
	return sawOutdated ? "outdated" : "up-to-date";
}

export interface PrecheckInput {
	/** 读本地 pi 版本(通常就是 `pi --version`) */
	piVersion: () => Promise<string | undefined>;
	settingsPath?: string;
	extensionsRoot?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	registry?: string;
}

/**
 * 三类更新的预检结论。任何一步读不到信息都退回 unknown(照旧更新),不抛错、不阻塞启动。
 */
export async function precheckUpdates(input: PrecheckInput): Promise<PrecheckResult> {
	const env = input.env ?? process.env;
	const settingsPath = input.settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
	const extensionsRoot = input.extensionsRoot ?? join(homedir(), ".pi", "agent", "npm", "node_modules");
	const fetchOptions = { fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs, registry: input.registry };

	const refs = extensionRefs(settingsPath, extensionsRoot);
	const [piVersion, latest] = await Promise.all([
		input.piVersion().catch(() => undefined),
		fetchLatestVersions([PI_PACKAGE, CLAUDE_PACKAGE, ...refs.map((ref) => ref.name)], fetchOptions),
	]);

	const piLatest = latest.get(PI_PACKAGE);
	const pi: PrecheckVerdict = piVersion && piLatest ? (piVersion === piLatest ? "up-to-date" : "outdated") : "unknown";
	const claudeVersion = claudeInstalledVersion(env);
	const claudeLatest = latest.get(CLAUDE_PACKAGE);
	const claude: PrecheckVerdict = claudeVersion && claudeLatest ? (claudeVersion === claudeLatest ? "up-to-date" : "outdated") : "unknown";
	const extensions = verdictOf(refs, latest);

	const skipped: string[] = [];
	if (pi === "up-to-date") skipped.push("pi 本体");
	if (extensions === "up-to-date") skipped.push("pi 扩展");
	if (claude === "up-to-date") skipped.push("Claude Code");
	return { pi, extensions, claude, note: skipped.length ? `已是最新,跳过: ${skipped.join(" / ")}` : undefined };
}
