/**
 * 模糊匹配:子序列匹配 + 打分(用于 TUI 过滤与会话名检索)
 */

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, "");
}

/** 命中判定:query 的字符按序出现在 text 中 */
export function fuzzyMatch(query: string, text: string): boolean {
	const q = normalize(query);
	if (!q) return true;
	const t = normalize(text);
	let i = 0;
	for (const ch of t) {
		if (ch === q[i]) i++;
		if (i === q.length) return true;
	}
	return false;
}

/**
 * 打分:连续匹配、词首匹配、越早出现得分越高。
 * 无匹配返回 null。
 */
export function fuzzyScore(query: string, text: string): number | null {
	const q = normalize(query);
	if (!q) return 0;
	const t = normalize(text);
	let score = 0;
	let ti = 0;
	let streak = 0;
	let prevIndex = -1;
	for (const qc of q) {
		let found = -1;
		for (let i = ti; i < t.length; i++) {
			if (t[i] === qc) {
				found = i;
				break;
			}
		}
		if (found === -1) return null;
		streak = found === prevIndex + 1 ? streak + 1 : 0;
		score += 10 - Math.min(9, found - ti); // 越靠前越好
		score += streak * 5; // 连续命中加分
		if (found === 0 || /[\s\-_/.:\\]/.test(t[found - 1] ?? "")) score += 8; // 词首/段首加分
		prevIndex = found;
		ti = found + 1;
	}
	// 短目标优先(避免长文本靠长度堆分)
	score -= Math.floor(t.length / 20);
	return score;
}

/** 按分数排序并过滤(空 query 时保持原序,只取 limit) */
export function rankByQuery<T>(items: T[], query: string, toText: (item: T) => string, limit = 200): T[] {
	if (!query.trim()) return items.slice(0, limit);
	const scored: { item: T; score: number }[] = [];
	for (const item of items) {
		const s = fuzzyScore(query, toText(item));
		if (s !== null) scored.push({ item, score: s });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((entry) => entry.item);
}
