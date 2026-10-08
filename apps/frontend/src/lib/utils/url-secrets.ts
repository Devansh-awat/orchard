export type UrlSecretKind = 'share' | 'slack-link';

const PREFIX = 'orchard:url-secret:';
const RETURN_KEY = 'inviteRedirect';
const memory = new Map<UrlSecretKind, string>();

function session(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value).trim();
	} catch {
		return value.trim();
	}
}

export function secretRoute(pathname: string): UrlSecretKind | null {
	if (pathname === '/share/sandbox' || pathname.startsWith('/share/sandbox/')) return 'share';
	if (pathname === '/integrations/slack/link' || pathname.startsWith('/integrations/slack/link/'))
		return 'slack-link';
	return null;
}

function remember(kind: UrlSecretKind, value: string) {
	memory.set(kind, value);
	try {
		session()?.setItem(PREFIX + kind, value);
	} catch {
		return;
	}
}

export function urlSecret(kind: UrlSecretKind): string | null {
	const known = memory.get(kind);
	if (known) return known;
	try {
		const saved = session()?.getItem(PREFIX + kind) ?? null;
		if (saved) memory.set(kind, saved);
		return saved;
	} catch {
		return null;
	}
}

export function forgetUrlSecret(kind: UrlSecretKind) {
	memory.delete(kind);
	try {
		session()?.removeItem(PREFIX + kind);
	} catch {
		return;
	}
}

export function captureUrlSecrets(): UrlSecretKind | null {
	if (typeof location === 'undefined' || typeof history === 'undefined') return null;
	const kind = secretRoute(location.pathname);
	if (!kind) return null;
	const url = new URL(location.href);
	let value = '';
	if (kind === 'share') {
		value = decode(url.hash.replace(/^#/, ''));
		url.hash = '';
	} else {
		value = decode(url.searchParams.get('token') ?? '');
		url.searchParams.delete('token');
	}
	if (!value) return kind;
	remember(kind, value);
	history.replaceState(history.state, '', `${url.pathname}${url.search}`);
	return kind;
}

export function rememberReturnTo(path: string) {
	if (!path.startsWith('/') || path.startsWith('//')) return;
	try {
		session()?.setItem(RETURN_KEY, path);
	} catch {
		return;
	}
}

export function takeReturnTo(): string | null {
	try {
		const store = session();
		const path = store?.getItem(RETURN_KEY) ?? null;
		if (!path) return null;
		store?.removeItem(RETURN_KEY);
		return path.startsWith('/') && !path.startsWith('//') ? path : null;
	} catch {
		return null;
	}
}

const TOKEN_PARAM = /([?&#](?:token|share_token|shareToken)=)[^&#\s"'<>]+/gi;
const SHARE_PATH_TOKEN = /\/share\/sandbox\/[A-Za-z0-9_~.%-]{16,}/g;
const SHARE_FRAGMENT = /(\/share\/sandbox[^\s"'<>#]*)#[^\s"'<>]*/g;

export function scrubUrlSecrets(text: string): string {
	if (!text.includes('token') && !text.includes('/share/sandbox')) return text;
	return text
		.replace(TOKEN_PARAM, '$1redacted')
		.replace(SHARE_PATH_TOKEN, '/share/sandbox/redacted')
		.replace(SHARE_FRAGMENT, '$1');
}

export function scrubDeep<T>(value: T, depth = 0): T {
	if (typeof value === 'string') return scrubUrlSecrets(value) as T;
	if (depth > 6 || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1)) as T;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[key] = scrubDeep(item, depth + 1);
	}
	return out as T;
}
