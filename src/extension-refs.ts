/**
 * 收集"受管扩展都有哪些、本地各是什么版本"(纯读文件,毫秒级)。
 *
 * 三个来源都要看,少一个就会误判"已是最新"并跳过 `pi update --extensions`:
 *   1. 用户 settings 的 packages
 *   2. `<agentDir>/npm/package.json` 的 dependencies(实测有扩展只在这里,不在 settings 里 ——
 *      2026-11-19 的 `@signalridge/pi-tab-status` 就是这么永远落后的)
 *   3. 工程 settings 的 packages(版本从 `<cwd>/.pi/npm` 读)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PkgRef {
	name: string;
	/** 本地已装版本;读不到为 undefined */
	installed?: string;
	/** settings 里写死的版本(`npm:pkg@1.2.3`) */
	pin?: string;
	/**
	 * 只在 `<agentDir>/npm/package.json` 里、不在任何 settings 里(孤儿)。
	 *
	 * `pi update --extensions` 只遍历 settings 的 packages(实测读源码确认),所以孤儿**永远不会**
	 * 被它更新 —— 把它们算进"是否该跑更新"的判断会永远判 outdated,导致每次启动都白跑 18 秒。
	 * 因此单独标出来只作提示。
	 */
	orphan?: boolean;
}

export function readPkgVersion(pkgJsonPath: string): string | undefined {
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
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

/** 读一个 settings 文件里的 packages 条目(读不到/格式不对返回空数组) */
function packagesOf(settingsPath: string): { name: string; pin?: string }[] {
	let packages: unknown;
	try {
		packages = (JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown }).packages;
	} catch {
		return [];
	}
	if (!Array.isArray(packages)) return [];
	return packages
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((entry) => parsePackageEntry(entry));
}

/** 读 `npm/package.json` 的 dependencies 名字(pi 的受管扩展清单) */
function manifestNames(manifestPath: string): string[] {
	try {
		const deps = (JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, unknown> }).dependencies;
		return deps && typeof deps === "object" ? Object.keys(deps) : [];
	} catch {
		return [];
	}
}

export interface ExtensionRefOptions {
	/** 受管扩展清单 `<agentDir>/npm/package.json`:pi 会更新这里声明的所有依赖 */
	manifestPath?: string;
	/** 工程作用域的 settings(`<cwd>/.pi/agent/settings.json`) */
	projectSettingsPath?: string;
	/** 工程作用域的已装位置(`<cwd>/.pi/npm/node_modules`) */
	projectModulesRoot?: string;
}

export function extensionRefs(settingsPath: string, modulesRoot: string, options: ExtensionRefOptions = {}): PkgRef[] {
	const userEntries = packagesOf(settingsPath);
	// 在**家目录**里启动时,`<cwd>/.pi/agent/settings.json` 就是那份全局 settings —— 不能当工程作用域,
	// 否则工程安装根(`~/.pi/npm/node_modules`)会被当成这些包的来源,结果所有版本都读不到(→ 全 unknown)。
	const projectSettingsPath =
		options.projectSettingsPath && resolve(options.projectSettingsPath) !== resolve(settingsPath) ? options.projectSettingsPath : undefined;
	const userNames = new Set(userEntries.map((entry) => entry.name));
	const projectOnly = (projectSettingsPath ? packagesOf(projectSettingsPath) : []).filter((entry) => !userNames.has(entry.name));
	const projectNames = new Set(projectOnly.map((entry) => entry.name));

	const entries: (PkgRef & { pin?: string })[] = [...userEntries];
	const seen = new Set(entries.map((entry) => entry.name));
	for (const name of options.manifestPath ? manifestNames(options.manifestPath) : []) {
		if (seen.has(name)) continue;
		entries.push({ name, orphan: true });
		seen.add(name);
	}
	for (const entry of projectOnly) {
		if (seen.has(entry.name)) continue;
		entries.push(entry);
		seen.add(entry.name);
	}

	return entries.map((entry) => {
		const root = projectNames.has(entry.name) && options.projectModulesRoot ? options.projectModulesRoot : modulesRoot;
		const ref: PkgRef = { name: entry.name, installed: readPkgVersion(join(root, ...entry.name.split("/"), "package.json")), pin: entry.pin };
		if (entry.orphan) ref.orphan = true;
		return ref;
	});
}

export interface RefSources {
	settingsPath: string;
	modulesRoot: string;
	manifestPath: string;
	projectSettingsPath: string;
	projectModulesRoot: string;
}

/** 默认来源:按 pi 的目录布局推出这些路径(测试可整套覆盖) */
export function defaultRefSources(agentDir: string = join(homedir(), ".pi", "agent"), cwd: string = process.cwd()): RefSources {
	return {
		settingsPath: join(agentDir, "settings.json"),
		modulesRoot: join(agentDir, "npm", "node_modules"),
		manifestPath: join(agentDir, "npm", "package.json"),
		projectSettingsPath: join(cwd, ".pi", "agent", "settings.json"),
		projectModulesRoot: join(cwd, ".pi", "npm", "node_modules"),
	};
}
