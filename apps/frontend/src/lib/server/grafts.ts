import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { env } from '$env/dynamic/private';
import type { GraftScreen, GraftUiEntry } from '$lib/grafts/registry';

type Manifest = {
	id: string;
	name: string;
	version: string;
	entries?: { ui?: string };
	claims?: { uiAliases?: string[] };
	ui?: { screens?: Partial<GraftScreen>[] };
};

let cache: { at: number; entries: GraftUiEntry[]; dirs: Map<string, string> } | null = null;

export function graftsDir(): string {
	return resolve(env.ORCHARD_GRAFTS_DIR ?? '/app/grafts');
}

function walk(root: string, dir = root, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) walk(root, full, out);
		else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
	}
	return out.sort();
}

function digestOf(uiRoot: string): string {
	const hash = createHash('sha256');
	for (const file of walk(uiRoot)) {
		hash.update(file).update(
			createHash('sha256')
				.update(readFileSync(join(uiRoot, file)))
				.digest('hex')
		);
	}
	return hash.digest('hex').slice(0, 16);
}

function scan(): { entries: GraftUiEntry[]; dirs: Map<string, string> } {
	const root = graftsDir();
	const entries: GraftUiEntry[] = [];
	const dirs = new Map<string, string>();
	if (!existsSync(root)) return { entries, dirs };
	const indexPath = join(root, 'index.json');
	const order: string[] = existsSync(indexPath)
		? ((JSON.parse(readFileSync(indexPath, 'utf8')) as { order?: string[] }).order ?? [])
		: [];
	const ids = readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		.map((e) => e.name)
		.sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib) || a.localeCompare(b);
		});
	for (const id of ids) {
		try {
			const manifest = JSON.parse(readFileSync(join(root, id, 'graft.json'), 'utf8')) as Manifest;
			const entry = manifest.entries?.ui;
			if (manifest.id !== id || !entry) continue;
			const uiRoot = join(root, id, 'ui');
			if (!existsSync(uiRoot)) continue;
			const digest = digestOf(uiRoot);
			const assetBase = `/_grafts/${id}/${digest}`;
			const screens: GraftScreen[] = (manifest.ui?.screens ?? [])
				.filter((s): s is GraftScreen => !!s.id && !!s.path)
				.map((s) => ({ id: s.id, path: s.path, layout: s.layout ?? 'shell', title: s.title }));
			const roots = [
				id,
				...(manifest.claims?.uiAliases ?? []).map((a) => a.split('/')[0]),
				...screens
					.filter((s) => !s.path.startsWith('/admin/'))
					.map((s) => s.path.replace(/^\/+/, '').split('/')[0])
			].filter(Boolean);
			entries.push({
				id,
				name: manifest.name,
				version: manifest.version,
				digest,
				entry: `${assetBase}/${entry.replace(/^ui\//, '')}`,
				assetBase,
				screens,
				roots: [...new Set(roots)]
			});
			dirs.set(id, uiRoot);
		} catch {
			continue;
		}
	}
	return { entries, dirs };
}

export function loadGraftRegistry(): GraftUiEntry[] {
	const ttl = env.ORCHARD_GRAFTS_DEV === '1' ? 2000 : Infinity;
	if (!cache || Date.now() - cache.at > ttl) cache = { at: Date.now(), ...scan() };
	return cache.entries;
}

const TYPES: Record<string, string> = {
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	woff2: 'font/woff2',
	wasm: 'application/wasm',
	map: 'application/json'
};

export function graftAsset(id: string, digest: string, file: string): Response {
	loadGraftRegistry();
	const graft = cache?.entries.find((g) => g.id === id);
	const uiRoot = cache?.dirs.get(id);
	if (!graft || !uiRoot || graft.digest !== digest)
		return new Response('not found', { status: 404 });
	const target = resolve(uiRoot, file);
	if (!target.startsWith(uiRoot + sep) || !existsSync(target) || !statSync(target).isFile()) {
		return new Response('not found', { status: 404 });
	}
	const ext = target.split('.').pop()?.toLowerCase() ?? '';
	return new Response(readFileSync(target), {
		headers: {
			'content-type': TYPES[ext] ?? 'application/octet-stream',
			'cache-control': 'public, max-age=31536000, immutable',
			'x-content-type-options': 'nosniff'
		}
	});
}
