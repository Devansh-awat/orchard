<script lang="ts" module>
	import * as api from './api';
	import type { GhShareLink } from './types';

	export const LINK_EXPIRY = [
		{ value: '24', label: '1 day' },
		{ value: '168', label: '7 days' },
		{ value: '720', label: '30 days' }
	];

	export class ShareLinkStore {
		links = $state.raw<GhShareLink[]>([]);
		loaded = $state(false);
		expiry = $state('168');
		scope = $state<'session' | 'machine'>('session');
		busy = $state<string | null>(null);
		error = $state<string | null>(null);
		fresh = $state<{ id: string; url: string; made: string } | null>(null);
		copied = $state(false);
		#copiedTimer: ReturnType<typeof setTimeout> | null = null;

		active = $derived(this.links.filter((l) => l.state === 'active'));
		current = $derived(!!this.fresh && this.fresh.made === `${this.scope}:${this.expiry}`);

		async load(sandboxId: string) {
			this.fresh = null;
			this.error = null;
			const res = await api.listShareLinks(sandboxId);
			this.links = res.ok ? (res.data.links ?? []) : [];
			this.loaded = true;
		}

		async create(sandboxId: string, sessionId: string | null): Promise<string | null> {
			if (this.busy) return null;
			this.busy = 'create';
			this.error = null;
			try {
				const link = await api.createShareLink(sandboxId, {
					sessionId: sessionId && this.scope === 'session' ? sessionId : null,
					expiresInHours: Number(this.expiry)
				});
				const url = `${location.origin}/share/sandbox#${link.token}`;
				this.fresh = { id: link.id, url, made: `${this.scope}:${this.expiry}` };
				this.links = [link, ...this.links.filter((l) => l.id !== link.id)];
				return url;
			} catch (e) {
				this.error = e instanceof Error ? e.message : "Couldn't create the link";
				return null;
			} finally {
				this.busy = null;
			}
		}

		async copy(url: string): Promise<boolean> {
			try {
				await navigator.clipboard.writeText(url);
				this.copied = true;
				if (this.#copiedTimer) clearTimeout(this.#copiedTimer);
				this.#copiedTimer = setTimeout(() => (this.copied = false), 1600);
				return true;
			} catch {
				return false;
			}
		}

		async revoke(sandboxId: string, link: GhShareLink): Promise<string | null> {
			if (this.busy) return null;
			this.busy = link.id;
			try {
				const next = await api.revokeShareLink(sandboxId, link.id);
				this.links = this.links.map((l) => (l.id === link.id ? { ...l, ...next } : l));
				if (this.fresh?.id === link.id) this.fresh = null;
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : "Couldn't revoke the link";
			} finally {
				this.busy = null;
			}
		}
	}
</script>

<script lang="ts">
	import { Check, Copy, X } from 'lucide-svelte';
	import { Button, Input } from '@orchardlabs/graft-ui';
	import SegmentedControl from '@orchardlabs/graft-ui/components/ui/SegmentedControl.svelte';
	import { toasts } from '../../host/stores';
	import { getGreenhouseApp } from './app.svelte';
	import FormError from './FormError.svelte';
	import { ago } from './format';

	let { store }: { store: ShareLinkStore } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const session = $derived(ws?.session ?? null);

	const SCOPES = [
		{ value: 'session', label: 'This session' },
		{ value: 'machine', label: 'Every session' }
	];

	const others = $derived(store.active.filter((l) => l.id !== store.fresh?.id));

	async function copyLink(url: string) {
		if (!(await store.copy(url)))
			toasts.add({ title: 'Copy the link from the field', color: 'info' });
	}

	function focusField(node: HTMLElement) {
		requestAnimationFrame(() => node.querySelector('input')?.focus({ preventScroll: true }));
	}

	async function revoke(link: GhShareLink) {
		if (!ws) return;
		const failed = await store.revoke(ws.sandboxId, link);
		if (failed)
			toasts.add({ title: "Couldn't revoke the link", description: failed, color: 'error' });
	}

	function remaining(iso: string | null): string {
		if (!iso) return 'Never expires';
		const ms = Date.parse(iso) - Date.now();
		if (ms <= 0) return 'Expired';
		const hours = Math.round(ms / 3_600_000);
		if (hours < 24) return `${Math.max(1, hours)} h left`;
		const days = Math.round(hours / 24);
		return `${days} ${days === 1 ? 'day' : 'days'} left`;
	}
</script>

<div class="opts">
	{#if session}
		<SegmentedControl options={SCOPES} bind:value={store.scope} label="What the link shows" grow />
	{/if}
	<SegmentedControl options={LINK_EXPIRY} bind:value={store.expiry} label="Expires after" grow />
</div>

{#if store.fresh}
	{@const url = store.fresh.url}
	<div class="fresh" {@attach focusField}>
		<Input
			value={url}
			readonly
			aria-label="Read-only link"
			class="gh-mono"
			onfocus={(e: FocusEvent) => (e.currentTarget as HTMLInputElement).select()}
		/>
		<Button variant="secondary" onclick={() => copyLink(url)}>
			{#if store.copied}<Check size={14} /> Copied{:else}<Copy size={14} /> Copy{/if}
		</Button>
	</div>
{/if}

{#if store.error}<FormError message={store.error} />{/if}

{#if others.length > 0}
	<ul class="gh-group" aria-label="Active links">
		{#each others as link (link.id)}
			<li class="gh-group-row gh-group-row--tight">
				<span class="gh-group-name">{link.session?.title ?? 'Every session'}</span>
				<span class="meta">
					{remaining(link.expiresAt)}{link.lastUsedAt ? ` · opened ${ago(link.lastUsedAt)}` : ''}
				</span>
				<button
					type="button"
					class="gh-ibtn"
					aria-label="Revoke link"
					title="Revoke link"
					disabled={!!store.busy}
					onclick={() => revoke(link)}
				>
					<X size={16} strokeWidth={1.75} />
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.opts {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.fresh {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.fresh :global(.input) {
		flex: 1;
		min-width: 0;
	}

	.meta {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}
</style>
