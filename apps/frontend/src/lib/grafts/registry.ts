export type GraftScreen = {
	id: string;
	path: string;
	layout: 'shell' | 'fullscreen';
	title?: string;
};

export type GraftUiEntry = {
	id: string;
	name: string;
	version: string;
	digest: string;
	entry: string;
	assetBase: string;
	screens: GraftScreen[];
	roots: string[];
};

type GraftGlobal = { __ORCHARD_GRAFTS__?: GraftUiEntry[] };

export function graftRegistry(): GraftUiEntry[] {
	return (globalThis as GraftGlobal).__ORCHARD_GRAFTS__ ?? [];
}

export function setGraftRegistry(entries: GraftUiEntry[]): void {
	(globalThis as GraftGlobal).__ORCHARD_GRAFTS__ = entries;
}

export function graftRoots(): Set<string> {
	return new Set(graftRegistry().flatMap((g) => g.roots));
}

export function screenRoot(path: string): string {
	return path.replace(/^\/+/, '').split('/')[0] ?? '';
}

export function matchScreenPath(pattern: string, path: string): Record<string, string> | null {
	const pat = pattern.replace(/\/+$/, '').split('/').filter(Boolean);
	const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
	const params: Record<string, string> = {};
	for (let i = 0; i < pat.length; i++) {
		const seg = pat[i];
		if (seg === '*') {
			params['*'] = parts.slice(i).map(decodeURIComponent).join('/');
			return params;
		}
		if (i >= parts.length) return null;
		if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
		else if (seg !== parts[i]) return null;
	}
	return parts.length === pat.length ? params : null;
}

export function findScreen(
	path: string
): { graft: GraftUiEntry; screen: GraftScreen; params: Record<string, string> } | null {
	for (const graft of graftRegistry()) {
		for (const screen of graft.screens) {
			const params = matchScreenPath(screen.path, path);
			if (params) return { graft, screen, params };
		}
	}
	return null;
}

export function isFullscreenGraftPath(path: string): boolean {
	return findScreen(path)?.screen.layout === 'fullscreen';
}
