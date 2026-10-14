<script lang="ts">
	import { untrack } from 'svelte';
	import { Check, ChevronDown, ChevronRight, Eye, Link, Users, X } from 'lucide-svelte';
	import { Button, Input, Menu, MenuItem } from '@orchardlabs/graft-ui';
	import Avatar from '@orchardlabs/graft-ui/components/ui/Avatar.svelte';
	import { toasts } from '../../host/stores';
	import * as api from './api';
	import { getGreenhouseApp } from './app.svelte';
	import FormError from './FormError.svelte';
	import ShareLinks, { ShareLinkStore } from './ShareLinks.svelte';
	import StepSheet from './StepSheet.svelte';
	import { StepStack } from './steps.svelte';
	import type { GhMember } from './types';

	type Step = 'overview' | 'who' | 'what' | 'done' | 'link';
	type Role = 'viewer' | 'collaborator';
	interface Invitee {
		key: string;
		userId?: string;
		email?: string;
		name: string;
		detail?: string | null;
		avatarUrl: string | null;
	}

	let { open = $bindable(false) }: { open?: boolean } = $props();

	const app = getGreenhouseApp();
	const ws = $derived(app.ws);
	const members = $derived(ws?.members ?? null);
	const manage = $derived(ws?.isOwner ?? false);
	const machineName = $derived(app.machine?.name ?? 'machine');

	const steps = new StepStack<Step>('overview');
	const links = new ShareLinkStore();

	const ACCESS = [
		{
			value: 'collaborator' as const,
			title: 'Collaborate',
			line: 'Prompt your agent, edit files, use terminals',
			note: 'Uses your Claude and this machine',
			icon: Users
		},
		{ value: 'viewer' as const, title: 'Watch', line: 'Read only', note: null, icon: Eye }
	];

	let candidates = $state.raw<api.OrgMemberLite[]>([]);
	let query = $state('');
	let highlight = $state(-1);
	let picked = $state.raw<Invitee[]>([]);
	let access = $state<Role>('collaborator');
	let invited = $state.raw<Invitee[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let searchBox = $state<HTMLElement | null>(null);

	let wasOpen = false;
	let candidatesFor: string | null = null;
	$effect(() => {
		const isOpen = open;
		if (isOpen && !wasOpen) untrack(startOver);
		wasOpen = isOpen;
	});

	function startOver() {
		query = '';
		highlight = -1;
		picked = [];
		access = 'collaborator';
		invited = [];
		error = null;
		if (!ws) return;
		void ws.refreshMembers();
		if (!manage) return;
		void links.load(ws.sandboxId);
		const org = app.organizationId ?? ws.machine?.organizationId ?? null;
		if (!org || org === candidatesFor) return;
		candidatesFor = org;
		void api.listOrgMembers(org).then((list) => (candidates = list));
	}

	const needle = $derived(query.trim().toLowerCase());
	const takenIds = $derived(
		new Set(
			[
				members?.owner?.id,
				...(members?.members ?? []).map((m) => m.user.id),
				...picked.map((p) => p.userId)
			].filter(Boolean)
		)
	);
	const takenEmails = $derived(
		new Set(
			[
				members?.owner?.email,
				...(members?.members ?? []).map((m) => m.user.email),
				...picked.map((p) => p.email),
				...candidates.map((c) => c.email)
			]
				.filter((e): e is string => !!e)
				.map((e) => e.toLowerCase())
		)
	);
	const options = $derived.by((): Invitee[] => {
		const found: Invitee[] = candidates
			.filter((c) => !takenIds.has(c.id))
			.filter(
				(c) =>
					!needle ||
					c.name.toLowerCase().includes(needle) ||
					(c.email ?? '').toLowerCase().includes(needle)
			)
			.slice(0, 6)
			.map((c) => ({
				key: c.id,
				userId: c.id,
				name: c.name,
				detail: c.email,
				avatarUrl: c.avatarUrl
			}));
		const email = query.trim();
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !takenEmails.has(needle)) {
			found.push({ key: `email:${needle}`, email, name: email, avatarUrl: null });
		}
		return found;
	});

	function roleLabel(role: Role): string {
		return role === 'collaborator' ? 'Guest' : 'Read only';
	}

	function firstName(p: Invitee): string {
		return p.email ? p.name : (p.name.split(' ')[0] ?? p.name);
	}

	const doneTitle = $derived.by(() => {
		const [a, b] = invited;
		if (!a) return 'Invited';
		if (invited.length === 1) return `Invited ${firstName(a)}`;
		if (invited.length === 2) return `Invited ${firstName(a)} and ${firstName(b)}`;
		return `Invited ${firstName(a)} and ${invited.length - 1} others`;
	});

	const title = $derived(
		{
			overview: `Share ${machineName}`,
			who: 'Who?',
			what: 'What can they do?',
			done: doneTitle,
			link: 'Read-only link'
		}[steps.current]
	);

	function focusSearch() {
		searchBox?.querySelector('input')?.focus();
	}

	function pick(p: Invitee) {
		picked = [...picked, p];
		query = '';
		highlight = -1;
		focusSearch();
	}

	function unpick(p: Invitee) {
		picked = picked.filter((x) => x.key !== p.key);
		focusSearch();
	}

	function onSearchKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlight = Math.min(options.length - 1, highlight + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(-1, highlight - 1);
		} else if (e.key === 'Enter' && highlight >= 0 && options[highlight]) {
			e.preventDefault();
			pick(options[highlight]);
		} else if (e.key === 'Escape' && query) {
			e.preventDefault();
			query = '';
			highlight = -1;
		} else if (e.key === 'Backspace' && !query && picked.length > 0) {
			picked = picked.slice(0, -1);
		}
	}

	async function invite() {
		if (!ws || busy || picked.length === 0) return;
		busy = true;
		error = null;
		const done: Invitee[] = [];
		const failed: string[] = [];
		for (const p of picked) {
			try {
				await api.addMember(
					ws.sandboxId,
					p.userId ? { userId: p.userId, role: access } : { email: p.email, role: access }
				);
				done.push(p);
			} catch (e) {
				failed.push(`${p.name}: ${e instanceof Error ? e.message : 'failed'}`);
			}
		}
		await ws.refreshMembers().catch(() => undefined);
		busy = false;
		if (done.length === 0) {
			error = failed.length === 1 ? failed[0] : 'Could not invite anyone';
			return;
		}
		if (failed.length > 0) {
			toasts.add({ title: 'Some invites failed', description: failed.join('\n'), color: 'error' });
		}
		invited = done;
		picked = [];
		steps.finish('done');
	}

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

	function setRole(m: GhMember, role: Role) {
		if (!ws || m.role === role) return;
		const id = ws.sandboxId;
		return act('Could not change access', () => api.setMemberRole(id, m.user.id, role));
	}

	function remove(m: GhMember) {
		if (!ws) return;
		const id = ws.sandboxId;
		return act('Could not remove', () => api.removeMember(id, m.user.id));
	}

	async function createLink() {
		if (!ws) return;
		const url = await links.create(ws.sandboxId, ws.session?.id ?? null);
		if (url) await links.copy(url);
	}

	async function copyMachineLink() {
		if (!ws) return;
		const session = ws.session;
		const url = `${location.origin}/sandboxes/${ws.sandboxId}${session ? `?session=${session.id}` : ''}`;
		try {
			await navigator.clipboard.writeText(url);
			toasts.add({ title: 'Link copied', color: 'success' });
		} catch {
			toasts.add({
				title: 'Copy the link from here',
				description: url,
				color: 'info',
				duration: 0
			});
		}
	}

	function onenter() {
		const step = steps.current;
		if (step === 'overview' && manage) steps.push('who');
		else if (step === 'who' && picked.length > 0) steps.push('what');
		else if (step === 'what') void invite();
		else if (step === 'done') open = false;
		else if (step === 'link') {
			if (links.current) steps.back();
			else void createLink();
		}
	}
</script>

{#snippet face(id: string, name: string, url: string | null | undefined, px = 28)}
	<span class="gh-face" style="--face: {px}px" aria-hidden="true">
		<Avatar user={{ id, name, imageUrl: url ?? undefined }} size={px} />
	</span>
{/snippet}

<StepSheet bind:open {steps} {title} {onenter}>
	{#if steps.current === 'overview'}
		{#if members}
			<ul class="gh-group" aria-label="People">
				{#if members.owner}
					<li class="gh-group-row">
						{@render face(members.owner.id, members.owner.name, members.owner.avatarUrl)}
						<span class="gh-group-name" title={members.owner.email ?? undefined}
							>{members.owner.name}</span
						>
						<span class="role">Host</span>
					</li>
				{/if}
				{#each members.members as m (m.user.id)}
					<li class="gh-group-row">
						{@render face(m.user.id, m.user.name, m.user.avatarUrl)}
						<span class="gh-group-name" title={m.user.email ?? undefined}>{m.user.name}</span>
						{#if manage}
							<Menu placement="bottom-end">
								{#snippet trigger(props, isOpen)}
									<button
										{...props}
										type="button"
										class="role-btn"
										aria-expanded={isOpen}
										aria-label="{roleLabel(m.role)}, change access for {m.user.name}"
										title="Change access for {m.user.name}"
										disabled={busy}
									>
										{roleLabel(m.role)}
										<ChevronDown size={14} strokeWidth={1.75} />
									</button>
								{/snippet}
								<MenuItem onclick={() => setRole(m, 'collaborator')}>
									<span class="tick"
										>{#if m.role === 'collaborator'}<Check size={14} />{/if}</span
									>
									Guest
								</MenuItem>
								<MenuItem onclick={() => setRole(m, 'viewer')}>
									<span class="tick"
										>{#if m.role === 'viewer'}<Check size={14} />{/if}</span
									>
									Read only
								</MenuItem>
								<MenuItem danger onclick={() => remove(m)}>
									<span class="tick"></span>
									Remove
								</MenuItem>
							</Menu>
						{:else}
							<span class="role">{roleLabel(m.role)}</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if manage}
			<div class="gh-group">
				<button type="button" class="gh-group-row" onclick={() => steps.push('link')}>
					<span class="glyph"><Link size={16} strokeWidth={1.75} /></span>
					<span class="gh-group-label">Read-only link</span>
					<span class="gh-group-value">
						{links.active.length > 0 ? `${links.active.length} active` : ''}
					</span>
					<span class="gh-group-chev"><ChevronRight size={16} strokeWidth={1.75} /></span>
				</button>
			</div>
		{/if}
	{:else if steps.current === 'who'}
		{#if picked.length > 0}
			<ul class="chips" aria-label="Inviting">
				{#each picked as p (p.key)}
					<li class="chip">
						{@render face(p.userId ?? p.key, p.name, p.avatarUrl, 20)}
						<span class="chip-name">{p.name}</span>
						<button
							type="button"
							class="chip-x"
							aria-label="Remove {p.name}"
							title="Remove {p.name}"
							onclick={() => unpick(p)}
						>
							<X size={14} strokeWidth={1.75} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="search" bind:this={searchBox}>
			<Input
				bind:value={query}
				placeholder="Name or email"
				aria-label="Search people"
				autocomplete="off"
				role="combobox"
				aria-autocomplete="list"
				aria-expanded={options.length > 0}
				aria-controls="gh-share-options"
				aria-activedescendant={highlight >= 0 ? `gh-share-opt-${highlight}` : undefined}
				data-autofocus
				oninput={() => (highlight = query.trim() ? 0 : -1)}
				onkeydown={onSearchKey}
			/>
		</div>
		{#if options.length > 0}
			<ul class="gh-group" id="gh-share-options" role="listbox" aria-label="People">
				{#each options as o, i (o.key)}
					<li role="none">
						<button
							type="button"
							id="gh-share-opt-{i}"
							role="option"
							tabindex="-1"
							aria-selected={i === highlight}
							class="gh-group-row opt"
							class:opt--on={i === highlight}
							onmousedown={(e: MouseEvent) => e.preventDefault()}
							onmousemove={() => (highlight = i)}
							onclick={() => pick(o)}
						>
							{@render face(o.userId ?? o.key, o.name, o.avatarUrl)}
							<span class="gh-group-name">{o.name}</span>
							{#if o.detail}<span class="detail">{o.detail}</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{:else if needle}
			<p class="gh-sheet-note">No matches</p>
		{/if}
	{:else if steps.current === 'what'}
		<div class="choices" role="radiogroup" aria-label="Access">
			{#each ACCESS as a (a.value)}
				<label class="choice" class:choice--on={access === a.value}>
					<input
						type="radio"
						class="sr-only"
						name="gh-share-access"
						value={a.value}
						bind:group={access}
						data-autofocus={access === a.value ? '' : undefined}
					/>
					<span class="choice-ico"><a.icon size={16} strokeWidth={1.75} /></span>
					<span class="choice-text">
						<span class="choice-title">{a.title}</span>
						<span class="choice-line">{a.line}</span>
						{#if a.note}<span class="choice-note">{a.note}</span>{/if}
					</span>
					<span class="choice-mark" aria-hidden="true">
						{#if access === a.value}<Check size={16} strokeWidth={1.75} />{/if}
					</span>
				</label>
			{/each}
		</div>
		{#if error}<FormError message={error} />{/if}
	{:else if steps.current === 'done'}
		<div class="faces">
			{#each invited as p (p.key)}
				{@render face(p.userId ?? p.key, p.name, p.avatarUrl)}
			{/each}
		</div>
	{:else if steps.current === 'link'}
		<ShareLinks store={links} />
	{/if}

	{#snippet footer()}
		{#if steps.current === 'overview'}
			{#if manage}
				<Button variant="primary" onclick={() => steps.push('who')}>Invite people</Button>
			{:else}
				<Button variant="secondary" onclick={() => (open = false)}>Done</Button>
			{/if}
		{:else if steps.current === 'who'}
			<Button variant="primary" disabled={picked.length === 0} onclick={() => steps.push('what')}>
				Next
			</Button>
		{:else if steps.current === 'what'}
			<Button variant="primary" disabled={busy} onclick={invite}>
				{busy ? 'Inviting…' : 'Invite'}
			</Button>
		{:else if steps.current === 'done'}
			<Button variant="secondary" onclick={copyMachineLink}><Link size={14} /> Copy link</Button>
			<Button variant="primary" onclick={() => (open = false)}>Done</Button>
		{:else if steps.current === 'link'}
			{#if links.current}
				<Button variant="primary" onclick={() => steps.back()}>Done</Button>
			{:else}
				<Button variant="primary" disabled={!!links.busy} onclick={createLink}>
					{links.busy === 'create' ? 'Creating…' : 'Create link'}
				</Button>
			{/if}
		{/if}
	{/snippet}
</StepSheet>

<style>
	.role {
		flex: none;
		color: var(--gh-muted);
	}

	.role-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		height: var(--gh-icon);
		margin-right: -0.5rem;
		padding: 0 0.5rem;
		border-radius: var(--gh-r-control);
		color: var(--gh-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.role-btn:hover:not(:disabled),
	.role-btn[aria-expanded='true'] {
		color: var(--gh-text);
		background: var(--gh-hover);
	}

	.role-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.tick {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
	}

	.glyph {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.75rem;
		color: var(--gh-muted);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 100%;
		height: 1.75rem;
		padding: 0 0.125rem 0 0.25rem;
		border-radius: var(--radius-pill);
		background: var(--gh-selected);
	}

	.chip-name {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.chip-x {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-pill);
		color: var(--gh-muted);
		cursor: pointer;
		transition:
			color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.chip-x:hover {
		color: var(--gh-text);
		background: var(--gh-hover);
	}

	.chip-x:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.search :global(.input) {
		width: 100%;
	}

	.opt--on {
		background: var(--gh-hover);
	}

	.detail {
		flex: none;
		max-width: 50%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-faint);
	}

	.choices {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.choice {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--gh-line);
		background: var(--gh-field);
		cursor: pointer;
		transition:
			border-color var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}

	.choice:hover {
		background: var(--gh-hover);
	}

	.choice--on {
		border-color: var(--focus-ring-color);
	}

	.choice:has(:focus-visible) {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.choice-ico,
	.choice-mark {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: var(--gh-lh-ui);
	}

	.choice-ico {
		color: var(--gh-muted);
	}

	.choice-mark {
		color: var(--focus-ring-color);
	}

	.choice-text {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.choice-title {
		font-weight: 600;
		color: var(--gh-text);
	}

	.choice-line {
		color: var(--gh-text);
	}

	.choice-note {
		margin-top: 0.25rem;
		font-size: var(--gh-caption);
		line-height: var(--gh-lh-caption);
		color: var(--gh-muted);
	}

	.faces {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
</style>
