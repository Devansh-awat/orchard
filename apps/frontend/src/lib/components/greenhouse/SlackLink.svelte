<script lang="ts">
	import { CircleCheck, MessageSquare } from 'lucide-svelte';
	import { Alert, Button } from '$lib/components/ui';
	import { user } from '$lib/stores';
	import { linkSlack } from './integrations';

	let { token }: { token: string | null } = $props();

	let phase = $state<'confirm' | 'linking' | 'done' | 'error'>('confirm');
	let team = $state<string | null>(null);
	let error = $state('');

	const valid = $derived(!!token && /^[A-Za-z0-9_-]{43}$/.test(token));
	const who = $derived(
		$user
			? [$user.firstName, $user.lastName].filter(Boolean).join(' ') || $user.username || $user.email
			: null
	);

	async function confirm() {
		if (!token || phase === 'linking') return;
		phase = 'linking';
		try {
			const res = await linkSlack(token);
			team = res.teamId;
			phase = 'done';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not link Slack';
			phase = 'error';
		}
	}
</script>

<div class="page">
	<section class="card" aria-labelledby="slack-link-title">
		<span class="mark"><MessageSquare size={20} strokeWidth={1.75} /></span>
		{#if phase === 'done'}
			<h1 class="title" id="slack-link-title">
				<span class="ok"><CircleCheck size={20} strokeWidth={1.75} /></span> Slack is linked
			</h1>
			<p class="text">
				Your Slack account{team ? ` in workspace ${team}` : ''} now acts as {who ?? 'you'}. Run
				<span class="code">/greenhouse</span> followed by a prompt in Slack to start a session on your
				default machine.
			</p>
			<div class="actions">
				<Button variant="secondary" href="/user/settings?tab=sandbox">Connected accounts</Button>
				<Button variant="primary" href="/sandboxes">Open Greenhouse</Button>
			</div>
		{:else if !valid}
			<h1 class="title" id="slack-link-title">This link is incomplete</h1>
			<p class="text">
				Run <span class="code">/greenhouse link</span> in Slack again and open the new link it sends you.
				Links work once and expire after 10 minutes.
			</p>
		{:else}
			<h1 class="title" id="slack-link-title">Link your Slack account</h1>
			<p class="text">
				Slack asked to link the account that ran <span class="code">/greenhouse link</span> to
				{who ? `${who} on Orchard` : 'your Orchard account'}. Sessions you start from Slack run on
				your machines and as you.
			</p>
			<p class="note">Only confirm if you ran the command yourself in the last few minutes.</p>
			{#if phase === 'error'}
				<Alert tone="error" title="Not linked">{error}</Alert>
			{/if}
			<div class="actions">
				<Button variant="secondary" href="/">Cancel</Button>
				<Button
					variant="primary"
					loading={phase === 'linking'}
					disabled={phase === 'linking'}
					onclick={confirm}
				>
					Link Slack account
				</Button>
			</div>
		{/if}
	</section>
</div>

<style>
	.page {
		display: flex;
		justify-content: center;
		padding: clamp(3rem, 12vh, 7rem) 1.5rem 3rem;
	}

	.card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: 100%;
		max-width: 28rem;
		padding: 1.5rem;
		border-radius: var(--radius-lg);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
		box-shadow: var(--elev-1);
	}

	.mark {
		display: inline-grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: var(--fill-soft);
		color: var(--text-muted);
	}

	.title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.25rem 0 0;
		font-size: var(--text-body);
		line-height: 1.5rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.ok {
		display: inline-grid;
		color: var(--status-success);
	}

	.text,
	.note {
		margin: 0;
	}

	.text {
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		color: var(--text-muted);
	}

	.note {
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-faint);
	}

	.code {
		font-family: var(--font-mono-terminal);
		font-size: 0.9em;
		white-space: nowrap;
		color: var(--text-default);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
</style>
