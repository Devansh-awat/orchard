export const REPO_ICON_LUCIDE = [
	'rocket',
	'globe',
	'server',
	'database',
	'package',
	'terminal',
	'code',
	'book',
	'leaf',
	'sprout',
	'flame',
	'zap',
	'cpu',
	'cloud',
	'shield',
	'palette',
	'gamepad-2',
	'bot',
	'music',
	'camera'
] as const;

export type RepoLucideIcon = (typeof REPO_ICON_LUCIDE)[number];

export const REPO_EMOJI = [
	'🚀',
	'🌱',
	'🌳',
	'🍎',
	'🔥',
	'⚡',
	'✨',
	'💡',
	'🧪',
	'🛠️',
	'📦',
	'📚',
	'🎨',
	'🎮',
	'🎵',
	'🤖',
	'🐛',
	'🦊',
	'🐙',
	'🌍'
];

export const REPO_ICON_MAX_BYTES = 16;

export type RepoGithub = { owner: string; name: string };

export type RepoIconKind =
	| { kind: 'lucide'; name: RepoLucideIcon }
	| { kind: 'emoji'; value: string }
	| { kind: 'github'; owner: string }
	| { kind: 'initial' };

const LUCIDE = new Set<string>(REPO_ICON_LUCIDE);
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const FLAG_RE = /^\p{Regional_Indicator}{2}$/u;
const FORBIDDEN_RE = /[\p{Cc}\p{Zl}\p{Zp}\s]/u;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function isRepoEmoji(value: string): boolean {
	if (!value || new TextEncoder().encode(value).length > REPO_ICON_MAX_BYTES) return false;
	if (FORBIDDEN_RE.test(value)) return false;
	if ([...graphemes.segment(value)].length !== 1) return false;
	return PICTOGRAPHIC_RE.test(value) || FLAG_RE.test(value);
}

export function repoIconOf(
	icon: string | null | undefined,
	github: RepoGithub | null | undefined
): RepoIconKind {
	if (icon === 'github') {
		return github && OWNER_RE.test(github.owner)
			? { kind: 'github', owner: github.owner }
			: { kind: 'initial' };
	}
	if (icon?.startsWith('lucide:')) {
		const name = icon.slice('lucide:'.length);
		return LUCIDE.has(name)
			? { kind: 'lucide', name: name as RepoLucideIcon }
			: { kind: 'initial' };
	}
	if (icon && isRepoEmoji(icon)) return { kind: 'emoji', value: icon };
	return { kind: 'initial' };
}

export function githubAvatarUrl(owner: string): string {
	return `https://github.com/${encodeURIComponent(owner)}.png?size=64`;
}

export function repoIconLabel(name: string): string {
	return name
		.split('-')
		.map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
		.join(' ');
}
