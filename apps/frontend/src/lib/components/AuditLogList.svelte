<script lang="ts">
	import { onMount } from 'svelte';
	import { apiFetch, toasts } from '$lib/stores';
	import { Loader2, ScrollText, User, ArrowDown, RefreshCw } from 'lucide-svelte';
	import { Button } from '$lib/components/ui';

	interface Props {
		// One of: 'global' | { organizationId: string } | { deploymentId: string }
		scope: 'global' | { organizationId: string } | { deploymentId: string };
		title?: string;
	}

	let { scope, title = 'Audit Log' }: Props = $props();

	interface Actor {
		id: string;
		email: string;
		username?: string;
		firstName?: string | null;
		lastName?: string | null;
		imageUrl?: string | null;
	}
	interface Entry {
		id: string;
		createdAt: string;
		action: string;
		actorUserId: string | null;
		actorEmail: string | null;
		organizationId: string | null;
		projectId: string | null;
		deploymentId: string | null;
		targetType: string | null;
		targetId: string | null;
		targetLabel: string | null;
		metadata: Record<string, unknown> | null;
		actor: Actor | null;
	}

	let entries = $state<Entry[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let nextCursor = $state<string | null>(null);
	let actionFilter = $state('');

	function endpoint(): string {
		if (scope === 'global') return '/apiv1/audit-logs/global';
		if ('organizationId' in scope) return `/apiv1/audit-logs/organization/${scope.organizationId}`;
		return `/apiv1/audit-logs/deployment/${scope.deploymentId}`;
	}

	async function load(reset = false) {
		if (reset) {
			if (!entries.length) loading = true;
			nextCursor = null;
		} else {
			loadingMore = true;
		}
		try {
			const params = new URLSearchParams({ limit: '50' });
			if (!reset && nextCursor) params.set('cursor', nextCursor);
			if (actionFilter.trim()) params.set('action', actionFilter.trim());
			const res = await apiFetch(`${endpoint()}?${params}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message || 'Failed to fetch audit logs');
			}
			const data = await res.json();
			entries = reset ? data.entries : [...entries, ...data.entries];
			nextCursor = data.nextCursor;
		} catch (e) {
			toasts.add({
				title: 'Error',
				description: e instanceof Error ? e.message : 'Failed to load audit logs',
				color: 'error'
			});
		} finally {
			loading = false;
			loadingMore = false;
		}
	}

	function actorName(entry: Entry): string {
		if (!entry.actor) return entry.actorEmail || 'System';
		const fn = [entry.actor.firstName, entry.actor.lastName].filter(Boolean).join(' ');
		return fn || entry.actor.username || entry.actor.email;
	}

	function formatAction(action: string): string {
		return action
			.split('.')
			.map((p) => p.replace(/_/g, ' '))
			.join(' › ');
	}

	function formatMetadata(meta: Record<string, unknown> | null): string {
		if (!meta) return '';
		const parts: string[] = [];
		for (const [key, value] of Object.entries(meta)) {
			if (Array.isArray(value) && value.length === 2) {
				parts.push(`${key}: ${formatVal(value[0])} → ${formatVal(value[1])}`);
			} else if (value !== null && value !== undefined && value !== '') {
				parts.push(`${key}: ${formatVal(value)}`);
			}
		}
		return parts.join(' · ');
	}

	function formatVal(v: unknown): string {
		if (v === null) return '∅';
		if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
		return String(v);
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleString();
	}

	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	function onFilterInput() {
		if (searchTimer) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => load(true), 300);
	}

	onMount(() => {
		void load(true);
	});
</script>

<div
	class="rounded-2xl border"
	style="border-color: var(--surface-border); background-color: var(--center-channel-bg);"
>
	<div
		class="flex items-center justify-between gap-3 border-b px-5 py-4"
		style="border-color: var(--surface-border);"
	>
		<div class="flex items-center gap-2">
			<ScrollText class="h-4 w-4" style="color: var(--surface-muted);" />
			<h3 class="text-sm font-semibold" style="color: var(--center-channel-color);">{title}</h3>
			<span class="text-xs" style="color: var(--surface-muted);">— last 180 days</span>
		</div>
		<div class="flex items-center gap-2">
			<input
				type="text"
				bind:value={actionFilter}
				oninput={onFilterInput}
				placeholder="Filter by action (e.g. deployment.restarted)"
				class="rounded-lg border px-3 py-1 text-sm"
				style="border-color: var(--surface-border); background-color: var(--control-bg); color: var(--center-channel-color); min-width: 280px;"
			/>
			<Button variant="ghost" size="sm" aria-label="Refresh audit log" onclick={() => load(true)}>
				<RefreshCw size={14} />
			</Button>
		</div>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-5 w-5 animate-spin" style="color: var(--surface-muted);" />
		</div>
	{:else if entries.length === 0}
		<div class="px-5 py-12 text-center text-sm" style="color: var(--surface-muted);">
			No audit log entries.
		</div>
	{:else}
		<ul class="divide-y" style="border-color: var(--surface-border);">
			{#each entries as entry (entry.id)}
				<li class="px-5 py-3">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 text-sm">
								<span class="font-mono font-semibold" style="color: var(--center-channel-color);"
									>{formatAction(entry.action)}</span
								>
								{#if entry.targetLabel}
									<span style="color: var(--surface-muted);">·</span>
									<span class="truncate" style="color: var(--center-channel-color);"
										>{entry.targetLabel}</span
									>
								{/if}
							</div>
							{#if entry.metadata && Object.keys(entry.metadata).length}
								<div class="mt-1 truncate font-mono text-xs" style="color: var(--surface-muted);">
									{formatMetadata(entry.metadata)}
								</div>
							{/if}
							<div
								class="mt-1 flex items-center gap-2 text-xs"
								style="color: var(--surface-muted);"
							>
								<User class="h-3 w-3" />
								<span>{actorName(entry)}</span>
								<span>·</span>
								<time>{formatDate(entry.createdAt)}</time>
							</div>
						</div>
					</div>
				</li>
			{/each}
		</ul>

		{#if nextCursor}
			<div class="border-t px-5 py-3 text-center" style="border-color: var(--surface-border);">
				<button
					onclick={() => load(false)}
					disabled={loadingMore}
					class="inline-flex items-center gap-2 rounded-lg px-3 py-1 text-sm font-medium hover:opacity-80 disabled:opacity-50"
					style="color: var(--primary-700);"
				>
					{#if loadingMore}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<ArrowDown class="h-4 w-4" />
					{/if}
					Load more
				</button>
			</div>
		{/if}
	{/if}
</div>
