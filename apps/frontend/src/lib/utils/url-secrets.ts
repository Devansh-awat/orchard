export type UrlSecretKind = `share:${string}` | `link:${string}`;

const PREFIX = 'orchard:url-secret:';
const RETURN_KEY = 'inviteRedirect';
const SHARE_ROUTE = /^\/share\/([a-z0-9][a-z0-9-]*)(?:\/|$)/;
const LINK_ROUTE = /^\/integrations\/([a-z0-9][a-z0-9-]*)\/link(?:\/|$)/;

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
	const share = SHARE_ROUTE.exec(pathname);
	if (share) return `share:${share[1]}`;
	const link = LINK_ROUTE.exec(pathname);
	if (link) return `link:${link[1]}`;
	return null;
}

function remember(kind: UrlSecretKind, value: string): boolean {
	try {
		const store = session();
		if (!store) return false;
		store.setItem(PREFIX + kind, value);
		return true;
	} catch {
		return false;
	}
}

export function captureUrlSecrets(): UrlSecretKind | null {
	if (typeof location === 'undefined' || typeof history === 'undefined') return null;
	const kind = secretRoute(location.pathname);
	if (!kind) return null;
	const url = new URL(location.href);
	const share = kind.startsWith('share:');
	const value = decode(share ? url.hash.replace(/^#/, '') : (url.searchParams.get('token') ?? ''));
	if (!value || !remember(kind, value)) return kind;
	if (share) url.hash = '';
	else url.searchParams.delete('token');
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
const SHARE_PATH_TOKEN = /(\/share\/[a-z0-9][a-z0-9-]*\/)[A-Za-z0-9_~.%-]{16,}/g;
const LINK_PATH_TOKEN = /(\/integrations\/[a-z0-9][a-z0-9-]*\/link\/)[A-Za-z0-9_~.%-]{16,}/g;
const SHARE_FRAGMENT = /(\/share\/[a-z0-9][a-z0-9-]*[^\s"'<>#]*)#[^\s"'<>]*/g;

export function scrubUrlSecrets(text: string): string {
	if (!text.includes('token') && !text.includes('/share/') && !text.includes('/link/')) return text;
	return text
		.replace(TOKEN_PARAM, '$1redacted')
		.replace(SHARE_PATH_TOKEN, '$1redacted')
		.replace(LINK_PATH_TOKEN, '$1redacted')
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
