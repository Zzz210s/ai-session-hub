/**
 * 注册表查询(npm registry)与版本解析,从 update-precheck.ts 拆出:
 * 那边要同时管"看哪些包"和"怎么查",加上工程作用域后超 200 行上限。
 */

const REGISTRY = "https://registry.npmjs.org";

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
 * 失败会**再试一次**并放宽超时:registry 偶尔会抽风(实测一次连续超时 ~10s,随后立刻恢复正常)。
 * 不重试的话,抽风期间每个包都是 unknown —— 表现为"预检没帮上忙,又跑一遍 37-180 秒的完整更新"。
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
