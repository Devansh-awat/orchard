<script lang="ts">
	import { Link, X } from 'lucide-svelte';
	import { Button, Input, Modal, Select } from '$lib/components/ui';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import { toasts } from '$lib/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import { HOST_DISCLOSURE, shareAcknowledged, acknowledgeShare } from './disclosure';
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
	let understood = $state(false);
	let acknowledged = $state(false);

	const canInvite = $derived(acknowledged || understood);

	let ackFor: string | null = null;
	$effect(() => {
		const id = app.machine?.id ?? null;
		if (!open || id === ackFor) return;
		ackFor = id;
		acknowledged = id ? shareAcknowledged(id) : false;
		understood = false;
	});

	function confirmDisclosure() {
		const id = app.machine?.id;
		if (!acknowledged && understood && id) {
			acknowledgeShare(id);
			acknowledged = true;
		}
	}

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
		if (!ws || !canInvite) return;
		confirmDisclosure();
		query = '';
		return act('Could not invite', () => api.addMember(ws.sandboxId, { userId, role }));
	}

	function inviteEmail() {
		const email = query.trim();
		if (!ws || !canInvite || !email.includes('@')) return;
		confirmDisclosure();
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
		<section class="disclosure" aria-labelledby="gh-share-disclosure">
			<p class="d-title" id="gh-share-disclosure">What guests get on this machine</p>
			<p class="d-text">{HOST_DISCLOSURE}</p>
			<p class="d-note">
				Everyone commits and pushes as themselves, with their own GitHub account. SSH, machine
				settings, people and preview deploys stay with you.
			</p>
			{#if manage && !acknowledged}
				<label class="ack">
					<input type="checkbox" bind:checked={understood} />
					I understand
				</label>
			{/if}
		</section>

		{#if manage}
			<div class="invite">
				<Input
					bind:value={query}
					placeholder="Name or email of someone in your organization"
					aria-label="Invite people"
					disabled={!canInvite}
					onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && inviteEmail()}
				/>
				<label class="ro">
					<input type="checkbox" bind:checked={readOnly} disabled={!canInvite} />
					Read-only guest
				</label>
			</div>
			{#if canInvite && query.trim() && matches.length > 0}
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
					<span class="tag">Host</span>
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
							title="Remove {m.user.name}"
							disabled={busy}
							onclick={() =>
								ws && act('Could not remove', () => api.removeMember(ws.sandboxId, m.user.id))}
						>
							<X size={16} strokeWidth={1.75} />
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
		gap: 1rem;
	}

	.disclosure {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
	}

	.d-title,
	.d-text,
	.d-note {
		margin: 0;
	}

	.d-title {
		font-weight: 600;
		color: var(--text-default);
	}

	.d-text {
		color: var(--text-default);
	}

	.d-note {
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.ack {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		align-self: flex-start;
		min-height: var(--gh-icon);
		font-weight: 600;
		cursor: pointer;
	}

	.invite {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.ro {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.role {
		flex: none;
		width: 11rem;
	}

	.matches {
		display: flex;
		flex-direction: column;
		margin-top: -0.5rem;
		padding: 0.25rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--border-default);
	}

	.people {
		display: flex;
		flex-direction: column;
	}

	.person {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		padding: 0.25rem 0.5rem;
		border-radius: var(--gh-r-row);
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
		color: var(--text-default);
	}

	.email {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-faint);
	}

	.tag,
	.add {
		flex: none;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--text-muted);
	}

	.muted {
		margin: 0;
		color: var(--text-faint);
	}

	.grow {
		flex: 1;
	}
</style>
