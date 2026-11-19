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
import type { PkgRef } from "./extension-refs.ts";
import type { RefSources } from "./extension-refs.ts";
import { extensionRefs, defaultRefSources, readPkgVersion } from "./extension-refs.ts";
import { fetchLatestVersions } from "./npm-registry.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 预检结论:一致 / 有新版本 / 未知(未知一律当作要更新) */
// 既有导入方(测试、preflight-run)从这里取,保持可用
export { fetchLatestVersions } from "./npm-registry.ts";
export { extensionRefs, parsePackageEntry, readPkgVersion, defaultRefSources } from "./extension-refs.ts";
export type { ExtensionRefOptions, PkgRef } from "./extension-refs.ts";

export type PrecheckVerdict = "up-to-date" | "outdated" | "unknown";

export interface PrecheckResult {
	pi: PrecheckVerdict;
	extensions: PrecheckVerdict;
	claude: PrecheckVerdict;
	/** 摘要文案,例如「已是最新: pi 本体 / pi 扩展」;没有跳过项时为 undefined */
	note?: string;
	/** 只提示、不参与判定的孤儿扩展(在受管清单里但不在 settings 里,pi 不会更新它们) */
	orphans?: OutdatedRef[];
	/** 这次查到的 registry latest(供更新后复核用) */
	latest?: Map<string, string>;
	/** 这次用的路径来源(更新后按同一批来源复核) */
	sources?: RefSources;
}

/** 一条「本地版本与目标不一致」的扩展 */
export interface OutdatedRef {
	name: string;
	installed?: string;
	target?: string;
}

/** 逐条比较(不区分孤儿);信息缺失的不算,避免误报 */
function laggingRefs(refs: PkgRef[], latest: Map<string, string>): OutdatedRef[] {
	const out: OutdatedRef[] = [];
	for (const ref of refs) {
		const target = ref.pin ?? latest.get(ref.name);
		if (!ref.installed || !target) continue;
		if (ref.installed !== target) out.push({ name: ref.name, installed: ref.installed, target });
	}
	return out;
}

/**
 * 逐条列出与目标版本不一致、且**会被 pi 更新**的扩展(pin 优先当目标)。
 * 孤儿(只在受管清单里)排除在外:pi update --extensions 不遍历它们,算进来就永远判 outdated。
 */
export function outdatedRefs(refs: PkgRef[], latest: Map<string, string>): OutdatedRef[] {
	return laggingRefs(refs.filter((ref) => !ref.orphan), latest);
}

/**
 * 更新**之后**按同一批来源重读一遍,列出仍然落后的扩展。
 *
 * 为什么要复核:`pi update --extensions` 有已知的"静默不生效"路径 —— npm 在包刚发布后
 * 可能解析到过期的注册表元数据,装上旧版本**却不报错**(pi 自己会打印 "is still X" 提示,
 * 退出码仍是 0)。不复核的话 ais 会把这种"不完全更新"记成成功并写 TTL,接下来 6 小时都不再试。
 */
export function stillOutdated(sources: RefSources, latest: Map<string, string>): OutdatedRef[] {
	const refs = extensionRefs(sources.settingsPath, sources.modulesRoot, sources);
	return outdatedRefs(refs, latest);
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";

/** AIS_UPDATE_PRECHECK=0 关闭预检(恢复"每次都跑") */
export function precheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AIS_UPDATE_PRECHECK !== "0";
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

/**
 * 一组包的结论:全部一致 → up-to-date;有任一确定不一致 → outdated;其余 → unknown。
 * pin 存在时只与 pin 比(pi update --extensions 会尊重 pin,不该因为上游有新版就触发更新)。
 */
export function verdictOf(refs: PkgRef[], latest: Map<string, string>): PrecheckVerdict {
	// 孤儿(只在受管清单里)不参与:pi update --extensions 不遍历它们,算进来会永远判 outdated
	const relevant = refs.filter((ref) => !ref.orphan);
	if (relevant.length === 0) return refs.length === 0 ? "unknown" : "up-to-date";
	for (const ref of relevant) {
		if (!ref.installed || !(ref.pin ?? latest.get(ref.name))) return "unknown";
	}
	return outdatedRefs(relevant, latest).length > 0 ? "outdated" : "up-to-date";
}

export interface PrecheckInput {
	/** 读本地 pi 版本(通常就是 `pi --version`) */
	piVersion: () => Promise<string | undefined>;
	settingsPath?: string;
	extensionsRoot?: string;
	/** 受管扩展清单 `<agentDir>/npm/package.json`(默认按 agentDir 推) */
	manifestPath?: string;
	/** 工程作用域 settings 与已装位置(默认 `<cwd>/.pi/...`) */
	projectSettingsPath?: string;
	projectModulesRoot?: string;
	/** 当前目录(默认 process.cwd(),用于推工程作用域路径) */
	cwd?: string;
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
	const fallback = defaultRefSources(undefined, input.cwd ?? process.cwd());
	// 受管清单跟着 settings 走:注入临时 settings 时不会去读真实的 ~/.pi/agent/npm
	const manifestPath = input.manifestPath ?? join(dirname(input.settingsPath ?? fallback.settingsPath), "npm", "package.json");
	const settingsPath = input.settingsPath ?? fallback.settingsPath;
	const extensionsRoot = input.extensionsRoot ?? fallback.modulesRoot;
	const fetchOptions = { fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs, registry: input.registry };

	// 三个来源一起看(用户 settings / 受管清单 / 工程 settings):漏一个就会误判"已是最新"并跳过更新
	const projectSettingsPath = input.projectSettingsPath ?? fallback.projectSettingsPath;
	const projectModulesRoot = input.projectModulesRoot ?? fallback.projectModulesRoot;
	const refs = extensionRefs(settingsPath, extensionsRoot, { manifestPath, projectSettingsPath, projectModulesRoot });
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

	// 孤儿:在受管清单里但不在任何 settings 里 —— pi update --extensions 不会碰它们,只作提示
	const orphans = laggingRefs(
		refs.filter((ref) => ref.orphan),
		latest,
	);

	const skipped: string[] = [];
	if (pi === "up-to-date") skipped.push("pi 本体");
	if (extensions === "up-to-date") skipped.push("pi 扩展");
	if (claude === "up-to-date") skipped.push("Claude Code");
	return {
		pi,
		extensions,
		claude,
		note: skipped.length ? `已是最新,跳过: ${skipped.join(" / ")}` : undefined,
		orphans,
		latest,
		sources: { settingsPath, modulesRoot: extensionsRoot, manifestPath, projectSettingsPath, projectModulesRoot },
	};
}
