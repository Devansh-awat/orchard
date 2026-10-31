const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const match = raw.match(FRONTMATTER);
	if (!match) return { meta: {}, body: raw };

	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const sep = line.indexOf(':');
		if (sep === -1) continue;
		meta[line.slice(0, sep).trim()] = line
			.slice(sep + 1)
			.trim()
			.replace(/^['"]|['"]$/g, '');
	}

	return { meta, body: raw.slice(match[0].length) };
}
