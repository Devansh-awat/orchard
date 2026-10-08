<script lang="ts">
	import { Copy, Link, X } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import StatusDot from '$lib/components/ui/StatusDot.svelte';
	import { statusMeta, type StatusMeta } from '$lib/components/ui/status';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import FormError from './FormError.svelte';
	import { ago } from './format';
	import type { GhShareLink } from './types';

	let { active }: { active: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const session = $derived(ws?.session ?? null);

	const EXPIRY = [
		{ value: '24', label: '1 day' },
		{ value: '168', label: '7 days' },
		{ value: '720', label: '30 days' }
	];

	let links = $state.raw<GhShareLink[]>([]);
	let loaded = $state(false);
	let expiry = $state('168');
	let scope = $state<'session' | 'machine'>('session');
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let fresh = $state<{ id: string; url: string } | null>(null);

	const scopeOptions = $derived(
		session
			? [
					{ value: 'session', label: 'This session' },
					{ value: 'machine', label: 'Every session' }
				]
			: []
	);
	const shown = $derived(
		[...links]
			.filter((l) => l.state === 'active' || l.id === fresh?.id)
			.concat(links.filter((l) => l.state !== 'active').slice(0, 3))
			.filter((l, i, all) => all.findIndex((x) => x.id === l.id) === i)
	);

	let loadedFor: string | null = null;
	$effect(() => {
		const id = active ? (ws?.sandboxId ?? null) : null;
		if (!id || id === loadedFor) return;
		loadedFor = id;
		fresh = null;
		error = null;
		void refresh(id);
	});

	async function refresh(id: string) {
		const res = await api.listShareLinks(id);
		links = res.ok ? (res.data.links ?? []) : [];
		loaded = true;
	}

	function viewerUrl(token: string): string {
		return `${location.origin}/share/sandbox#${token}`;
	}

	async function copy(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			toasts.add({
				title: 'Read-only link copied',
				description: 'People in your organization can open it until it expires.',
				color: 'success'
			});
		} catch {
			toasts.add({
				title: 'Copy the link from here',
				description: url,
				color: 'info',
				duration: 0
			});
		}
	}

	async function create() {
		if (!ws || busy) return;
		busy = 'create';
		error = null;
		try {
			const link = await api.createShareLink(ws.sandboxId, {
				sessionId: session && scope === 'session' ? session.id : null,
				expiresInHours: Number(expiry)
			});
			const url = viewerUrl(link.token);
			fresh = { id: link.id, url };
			links = [link, ...links.filter((l) => l.id !== link.id)];
			await copy(url);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create the link';
		} finally {
			busy = null;
		}
	}

	async function revoke(link: GhShareLink) {
		if (!ws || busy) return;
		busy = link.id;
		try {
			const next = await api.revokeShareLink(ws.sandboxId, link.id);
			links = links.map((l) => (l.id === link.id ? { ...l, ...next } : l));
			if (fresh?.id === link.id) fresh = null;
		} catch (e) {
			toasts.add({
				title: 'Could not revoke the link',
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = null;
		}
	}

	function remaining(iso: string | null): string {
		if (!iso) return 'Never expires';
		const ms = Date.parse(iso) - Date.now();
		if (ms <= 0) return 'Expired';
		const hours = Math.round(ms / 3_600_000);
		if (hours < 24) return `Expires in ${Math.max(1, hours)} h`;
		const days = Math.round(hours / 24);
		return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
	}

	function linkMeta(link: GhShareLink): StatusMeta {
		if (link.state === 'revoked') return statusMeta('neutral', 'Revoked');
		if (link.state === 'expired') return statusMeta('neutral', 'Expired');
		return statusMeta('success', remaining(link.expiresAt));
	}
</script>

<section class="links" aria-labelledby="gh-share-links">
	<p class="title" id="gh-share-links">Read-only link</p>
	<p class="muted">
		Anyone in your organization with the link can read the transcript and the changes. They cannot
		prompt, open terminals or see files outside the diff.
	</p>
	<div class="create">
		{#if scopeOptions.length > 0}
			<SegmentedControl options={scopeOptions} bind:value={scope} label="What the link shows" />
		{/if}
		<SegmentedControl options={EXPIRY} bind:value={expiry} label="Expires after" />
		<span class="grow"></span>
		<Button variant="secondary" disabled={!!busy} onclick={create}>
			<Link size={14} />
			{busy === 'create' ? 'Creating…' : 'Create link'}
		</Button>
	</div>
	{#if error}<FormError message={error} />{/if}

	{#if loaded && shown.length > 0}
		<div class="list">
			{#each shown as link (link.id)}
				{@const meta = linkMeta(link)}
				<div class="row" class:row--dead={link.state !== 'active'} data-align="share-row">
					<span class="ico"><StatusDot {meta} size={8} /></span>
					<span class="who">
						<span class="name">{link.session?.title ?? 'Every session on this machine'}</span>
						<span class="meta">
							{meta.label}{link.lastUsedAt ? ` · opened ${ago(link.lastUsedAt)}` : ''}
						</span>
					</span>
					{#if fresh?.id === link.id && link.state === 'active'}
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Copy link"
							title="Copy link again. It is only shown once."
							onclick={() => fresh && copy(fresh.url)}
						>
							<Copy size={16} strokeWidth={1.75} />
						</button>
					{/if}
					{#if link.state === 'active'}
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Revoke link"
							title="Revoke link"
							disabled={!!busy}
							onclick={() => revoke(link)}
						>
							<X size={16} strokeWidth={1.75} />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.links {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--gh-line);
	}

	.title,
	.muted {
		margin: 0;
	}

	.title {
		font-weight: 600;
	}

	.muted {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.create {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.grow {
		flex: 1;
	}

	.list {
		display: flex;
		flex-direction: column;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.25rem calc(0.5rem - var(--gh-ibtn-inset)) 0.25rem 0.5rem;
		border-radius: var(--gh-r-row);
	}

	.row--dead .name {
		color: var(--text-muted);
	}

	.ico {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.75rem;
		height: var(--gh-glyph);
	}

	.who {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text-default);
	}

	.meta {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}
</style>
