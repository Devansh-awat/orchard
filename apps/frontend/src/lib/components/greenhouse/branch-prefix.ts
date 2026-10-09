import type { BranchPrefixMode } from './prefs.svelte';

export const DEFAULT_BRANCH_PREFIX = 'orchard';
const MAX = 40;

export function cleanBranchPrefix(raw: string): string {
	const segments = raw
		.trim()
		.replace(/[^A-Za-z0-9._/-]+/g, '-')
		.split('/')
		.map((part) =>
			part
				.replace(/\.{2,}/g, '.')
				.replace(/^[.-]+/, '')
				.replace(/(?:\.lock)+$/i, '')
				.replace(/\.+$/, '')
		)
		.filter(Boolean);
	let out = '';
	for (const part of segments) {
		const next = out ? `${out}/${part}` : part;
		if (next.length > MAX) {
			if (!out)
				out = part
					.slice(0, MAX)
					.replace(/[.-]+$/, '')
					.replace(/\.lock$/i, '');
			break;
		}
		out = next;
	}
	return out;
}

export function branchPrefixFor(
	mode: BranchPrefixMode,
	custom: string,
	githubLogin: string | null | undefined
): string {
	if (mode === 'none') return '';
	if (mode === 'github') return cleanBranchPrefix(githubLogin ?? '') || DEFAULT_BRANCH_PREFIX;
	if (mode === 'custom') return cleanBranchPrefix(custom) || DEFAULT_BRANCH_PREFIX;
	return DEFAULT_BRANCH_PREFIX;
}
