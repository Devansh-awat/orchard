import { derived, type Readable as SvelteReadable } from 'svelte/store';
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import { apiFetch } from '$lib/stores/api';
import { user } from '$lib/stores/auth';
import { selectedOrganization } from '$lib/stores/organizations';
import { subscribeOrgEvents } from '$lib/stores/orgEvents';
import { themeStore } from '$lib/stores/theme';
import { toasts } from '$lib/stores/toast';
import { graftConfirms } from './confirm.svelte';
import { graftRegistry, type GraftUiEntry } from './registry';
import type {
	ApiInit,
	GraftClient,
	HostApi,
	HostOrg,
	HostOrgEvent,
	HostUser,
	SlotMap,
	SlotName
} from './types';

export type LoadedGraft = { graft: GraftUiEntry; client: GraftClient; host: HostApi };

export type SlotEntry<K extends SlotName> = {
	graftId: string;
	host: HostApi;
	item: SlotMap[K][number];
};

const hostUser: SvelteReadable<HostUser | null> = derived(user, ($user) =>
	$user
		? {
				id: $user.id,
				email: $user.email,
				username: $user.username ?? '',
				name:
					$user.fullName ??
					$user.name ??
					[$user.firstName, $user.lastName].filter(Boolean).join(' ') ??
					'',
				imageUrl: $user.imageUrl ?? null,
				isSuperAdmin: $user.isSuperAdmin === true
			}
		: null
);

const hostOrg: SvelteReadable<HostOrg | null> = derived(selectedOrganization, ($org) =>
	$org ? { id: $org.id, slug: $org.slug, name: $org.name } : null
);

const hostTheme = derived(themeStore.scheme, ($scheme) => ({
	mode: ($scheme === 'dark' ? 'dark' : 'light') as 'light' | 'dark'
}));

const hostRoute = derived(page, ($page) => ({
	path: $page.url.pathname,
	search: $page.url.search,
	params: { ...$page.params } as Record<string, string>
}));

function resolvePath(graft: GraftUiEntry, path: string): string {
	if (path.startsWith('/apiv1/')) return path;
	return `/apiv1/${graft.id}${path.startsWith('/') ? '' : '/'}${path}`;
}

function toRequest(init: ApiInit = {}): RequestInit {
	const { json, headers, ...rest } = init;
	if (json === undefined) return { ...rest, headers };
	return {
		...rest,
		body: JSON.stringify(json),
		headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) }
	};
}

const slotVersion = $state({ value: 0 });

function createHostApi(graft: GraftUiEntry): HostApi {
	const request = (path: string, init?: ApiInit) =>
		apiFetch(resolvePath(graft, path), toRequest(init));
	return {
		graft: {
			id: graft.id,
			version: graft.version,
			apiBase: `/apiv1/${graft.id}`,
			assetBase: graft.assetBase
		},
		stores: { user: hostUser, org: hostOrg, theme: hostTheme, route: hostRoute },
		fetch: request,
		async api<T>(path: string, init?: ApiInit): Promise<T> {
			const res = await request(path, init);
			const text = await res.text();
			const body = text ? safeJson(text) : null;
			if (!res.ok) {
				const message =
					(body as { message?: string } | null)?.message ?? `${res.status} ${res.statusText}`;
				throw new Error(message);
			}
			return body as T;
		},
		navigate(href, options) {
			void goto(href, {
				replaceState: options?.replace ?? false,
				keepFocus: options?.keepFocus ?? false,
				noScroll: options?.noScroll ?? false
			});
		},
		toast(message, tone = 'info', options) {
			toasts.add({
				title: message,
				color: tone,
				description: options?.description,
				action: options?.action
			});
		},
		refreshSlots() {
			slotVersion.value++;
		},
		confirm(options) {
			return graftConfirms.ask(options);
		},
		onOrgEvent(handler: (event: HostOrgEvent) => void) {
			let unsubscribeEvents: (() => void) | null = null;
			const unsubscribeOrg = hostOrg.subscribe((org) => {
				unsubscribeEvents?.();
				unsubscribeEvents = org
					? subscribeOrgEvents(org.id, (ev) => handler(ev as HostOrgEvent))
					: null;
			});
			return () => {
				unsubscribeOrg();
				unsubscribeEvents?.();
			};
		}
	};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const IMPORT_ATTEMPTS = 3;
const RELOAD_KEY = 'orchard:graft-reload-at';
const RELOAD_WINDOW_MS = 60_000;

async function importEntry(url: string): Promise<Record<string, unknown>> {
	let last: unknown = null;
	for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
		const target = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
		try {
			return await import(/* @vite-ignore */ target);
		} catch (err) {
			last = err;
			if (attempt < IMPORT_ATTEMPTS - 1)
				await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
		}
	}
	throw last;
}

function reloadOnce(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		const at = Number(window.sessionStorage.getItem(RELOAD_KEY));
		if (at && Date.now() - at < RELOAD_WINDOW_MS) return false;
		window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
	} catch {
		return false;
	}
	window.location.reload();
	return true;
}

if (typeof window !== 'undefined') {
	window.addEventListener('vite:preloadError', (event) => {
		if (reloadOnce()) event.preventDefault();
	});
}

class GraftHost {
	loaded = $state<LoadedGraft[]>([]);
	failed = $state<Record<string, string>>({});
	ready = $state(false);
	private started: Promise<void> | null = null;

	load(): Promise<void> {
		this.started ??= this.boot();
		return this.started;
	}

	private async boot() {
		const entries = graftRegistry();
		const serverCheck = apiFetch('/apiv1/grafts')
			.then(async (res) =>
				res.ok ? new Set(((await res.json()) as { id: string }[]).map((g) => g.id)) : null
			)
			.catch(() => null);
		const results = await Promise.all(
			entries.map(async (graft) => {
				const imported = importEntry(graft.entry).then(
					(mod) => ({ mod }),
					(err: Error) => ({ err })
				);
				const serverLoaded = await serverCheck;
				if (serverLoaded && !serverLoaded.has(graft.id)) {
					return { graft, error: 'the server did not load this graft' };
				}
				try {
					const settled = await imported;
					if ('err' in settled) throw settled.err;
					const mod = settled.mod;
					const client = (mod.default ?? mod.graft) as GraftClient | undefined;
					if (!client || typeof client !== 'object') throw new Error('entry has no default export');
					return { graft, client };
				} catch (err) {
					return { graft, error: (err as Error).message };
				}
			})
		);
		const loaded: LoadedGraft[] = [];
		const failed: Record<string, string> = {};
		for (const r of results) {
			if ('client' in r && r.client)
				loaded.push({ graft: r.graft, client: r.client, host: createHostApi(r.graft) });
			else failed[r.graft.id] = r.error ?? 'unknown error';
		}
		const stale = results.some(
			(r) => !('client' in r && r.client) && r.error !== 'the server did not load this graft'
		);
		if (stale && reloadOnce()) return;
		this.loaded = loaded;
		this.failed = failed;
		this.ready = true;
	}

	byId(id: string): LoadedGraft | undefined {
		return this.loaded.find((g) => g.graft.id === id);
	}

	refreshSlots(): void {
		slotVersion.value++;
	}

	slot<K extends SlotName>(name: K, props?: unknown): SlotEntry<K>[] {
		void slotVersion.value;
		const out: SlotEntry<K>[] = [];
		for (const { graft, client, host } of this.loaded) {
			const items = (client.slots?.[name] ?? []) as SlotMap[K];
			for (const item of items) {
				try {
					const visible = (item as { visible?: (h: HostApi, p: unknown) => boolean }).visible;
					if (visible && !visible(host, props)) continue;
				} catch {
					continue;
				}
				out.push({ graftId: graft.id, host, item });
			}
		}
		return out.sort(
			(a, b) =>
				((a.item as { order?: number }).order ?? 100) -
				((b.item as { order?: number }).order ?? 100)
		);
	}
}

export const graftHost = new GraftHost();
