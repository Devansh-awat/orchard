export function parseRepoInput(value: string): { owner: string; repo: string; url: string } | null {
	const urlMatch = value.match(/(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?.]+)/);
	if (urlMatch) {
		const owner = urlMatch[1];
		const repo = urlMatch[2].replace(/\.git$/, '');
		return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
	}
	const shortMatch = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
	if (shortMatch) {
		return {
			owner: shortMatch[1],
			repo: shortMatch[2],
			url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git`
		};
	}
	return null;
}
