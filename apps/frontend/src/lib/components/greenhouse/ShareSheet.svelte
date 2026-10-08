<script lang="ts">
	import { Link, ShieldAlert, X } from 'lucide-svelte';
	import { Button, Modal, Select } from '$lib/components/ui';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { hostOnly } from './workspace.svelte';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const members = $derived(ws?.members ?? null);
	const manage = $derived(ws?.isOwner ?? false);

	let candidates = $state<api.OrgMemberLite[]>([]);
	let query = $state('');
	let readOnly = $state(false);
	const role = $derived<'viewer' | 'collaborator'>(readOnly ? 'viewer' : 'collaborator');
	let busy = $state(false);

	const taken = $derived(
		new Set([members?.owner?.id, ...(members?.members ?? []).map((m) => m.user.id)].filter(Boolean))
	);
	const matches = $derived(
		candidates
			.filter((c) => !taken.has(c.id))
			.filter((c) => {
				const q = query.trim().toLowerCase();
				return !q || c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q);
			})
			.slice(0, 6)
	);

	let loadedFor: string | null = null;
	$effect(() => {
		if (!open) return;
		const org = app.organizationId ?? ws?.machine?.organizationId ?? null;
		void ws?.refreshMembers();
		if (!org || org === loadedFor || !manage) return;
		loadedFor = org;
		void api.listOrgMembers(org).then((list) => (candidates = list));
	});

	async function act(label: string, fn: () => Promise<unknown>) {
		if (!ws || busy) return;
		busy = true;
		try {
			await fn();
			await ws.refreshMembers();
		} catch (e) {
			toasts.add({
				title: label,
				description: e instanceof Error ? e.message : undefined,
				color: 'error'
			});
		} finally {
			busy = false;
		}
	}

	function invite(userId: string) {
		if (!ws) return;
		query = '';
		return act('Could not invite', () => api.addMember(ws.sandboxId, { userId, role }));
	}

	function inviteEmail() {
		const email = query.trim();
		if (!ws || !email.includes('@')) return;
		query = '';
		return act('Could not invite', () => api.addMember(ws.sandboxId, { email, role }));
	}

	async function copyLink() {
		if (!ws) return;
		const session = ws.session;
		const url = `${location.origin}/sandboxes/${ws.sandboxId}${session ? `?session=${session.id}` : ''}`;
		await navigator.clipboard.writeText(url);
		toasts.add({
			title: 'Link copied',
			description: 'Only members of this machine can open it.',
			color: 'success'
		});
	}
</script>

<Modal bind:open title="Share {app.machine?.name ?? 'machine'}" size="md">
	<div class="share">
		{#if manage}
			<div class="warn">
				<span class="warn-icon"><ShieldAlert size={16} strokeWidth={1.75} /></span>
				<p>
					Guests prompt your agent and commit with your credentials. Pushing, pull requests, SSH and
					machine settings stay with you, the host.
				</p>
			</div>
			<div class="invite">
				<input
					class="gh-field"
					bind:value={query}
					placeholder="Name or email of someone in your organization"
					aria-label="Invite people"
					onkeydown={(e) => e.key === 'Enter' && inviteEmail()}
				/>
				<label class="ro">
					<input type="checkbox" bind:checked={readOnly} />
					Read-only guest
				</label>
			</div>
			{#if query.trim() && matches.length > 0}
				<div class="matches">
					{#each matches as c (c.id)}
						<button
							type="button"
							class="person person--pick"
							disabled={busy}
							onclick={() => invite(c.id)}
						>
							<Avatar user={{ id: c.id, imageUrl: c.avatarUrl ?? undefined }} size={24} />
							<span class="who">
								<span class="name">{c.name}</span>
								{#if c.email}<span class="email">{c.email}</span>{/if}
							</span>
							<span class="add">Invite</span>
						</button>
					{/each}
				</div>
			{/if}
		{:else}
			<p class="muted">{hostOnly('invite people')}.</p>
		{/if}

		<div class="people">
			{#if members?.owner}
				<div class="person">
					<Avatar
						user={{ id: members.owner.id, imageUrl: members.owner.avatarUrl ?? undefined }}
						size={28}
					/>
					<span class="who">
						<span class="name">{members.owner.name}</span>
						{#if members.owner.email}<span class="email">{members.owner.email}</span>{/if}
					</span>
					<span class="host">Host</span>
				</div>
			{/if}
			{#each members?.members ?? [] as m (m.user.id)}
				<div class="person">
					<Avatar user={{ id: m.user.id, imageUrl: m.user.avatarUrl ?? undefined }} size={28} />
					<span class="who">
						<span class="name">{m.user.name}</span>
						{#if m.user.email}<span class="email">{m.user.email}</span>{/if}
					</span>
					{#if manage}
						<div class="role">
							<Select
								value={m.role}
								aria-label="Role for {m.user.name}"
								onchange={(e: Event) =>
									ws &&
									act('Could not change the role', () =>
										api.setMemberRole(
											ws.sandboxId,
											m.user.id,
											(e.currentTarget as HTMLSelectElement).value as 'viewer' | 'collaborator'
										)
									)}
							>
								<option value="collaborator">Guest</option>
								<option value="viewer">Read-only guest</option>
							</Select>
						</div>
						<button
							type="button"
							class="gh-ibtn"
							aria-label="Remove {m.user.name}"
							disabled={busy}
							onclick={() =>
								ws && act('Could not remove', () => api.removeMember(ws.sandboxId, m.user.id))}
						>
							<X size={14} strokeWidth={1.75} />
						</button>
					{:else}
						<span class="tag">{m.role === 'collaborator' ? 'Guest' : 'Read-only guest'}</span>
					{/if}
				</div>
			{:else}
				{#if members}
					<p class="muted">No guests yet.</p>
				{/if}
			{/each}
		</div>
	</div>
	{#snippet footer()}
		<Button variant="ghost" onclick={copyLink}><Link size={14} /> Copy link</Button>
		<span class="grow"></span>
		<Button variant="secondary" onclick={() => (open = false)}>Done</Button>
	{/snippet}
</Modal>

<style>
	.share {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		font-size: var(--text-footnote);
	}

	.warn {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.625rem 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in oklab, var(--status-warning) 30%, var(--border-default));
		background: color-mix(in oklab, var(--status-warning) 8%, transparent);
		color: var(--text-default);
	}

	.warn-icon {
		display: inline-grid;
		flex: none;
		margin-top: 0.0625rem;
		color: var(--status-warning);
	}

	.warn p {
		margin: 0;
	}

	.invite {
		display: flex;
		gap: 0.5rem;
	}

	.ro {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		flex: none;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.role {
		flex: none;
		width: 11rem;
	}

	.host {
		flex: none;
		padding: 0.0625rem 0.4375rem;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--accent) 14%, transparent);
		color: var(--accent);
		font-size: var(--text-caption);
		font-weight: 600;
	}

	.matches {
		display: flex;
		flex-direction: column;
		margin-top: -0.375rem;
		padding: 0.25rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
	}

	.people {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.person {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.75rem;
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-sm);
		text-align: left;
	}

	.person--pick:hover:not(:disabled) {
		background: var(--bg-hover);
	}

	.who {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-weight: 500;
		color: var(--text-default);
	}

	.email {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--text-caption);
		color: var(--text-faint);
	}

	.tag,
	.add {
		flex: none;
		font-size: var(--text-caption);
		color: var(--text-muted);
	}

	.add {
		color: var(--text-link);
	}

	.muted {
		margin: 0;
		color: var(--text-faint);
	}

	.grow {
		flex: 1;
	}
</style>
