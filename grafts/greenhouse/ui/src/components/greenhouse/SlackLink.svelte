<script lang="ts">
	import { CircleCheck, MessageSquare } from 'lucide-svelte';
	import { Alert, Button, Skeleton } from '@orchardlabs/graft-ui';
	import { user } from '../../host/stores';
	import { forgetUrlSecret } from '../../lib/utils/url-secrets';
	import {
		IntegrationError,
		linkSlack,
		previewSlackLink,
		type SlackLinkPreview
	} from './integrations';

	let { token }: { token: string | null } = $props();

	let phase = $state<'checking' | 'confirm' | 'linking' | 'done' | 'expired' | 'error'>('checking');
	let preview = $state.raw<SlackLinkPreview | null>(null);
	let error = $state('');

	const valid = $derived(!!token && /^[A-Za-z0-9_-]{43}$/.test(token));
	const who = $derived(
		$user
			? $user.name || $user.username || $user.email
			: null
	);
	const slackUser = $derived(
		preview ? (preview.slackUserName ? `@${preview.slackUserName}` : preview.slackUserId) : ''
	);
	const slackTeam = $derived(preview ? (preview.teamDomain ?? preview.teamId) : '');

	let checkedFor: string | null = null;
	$effect(() => {
		const current = valid ? token : null;
		if (!current || current === checkedFor) return;
		checkedFor = current;
		void check(current);
	});

	async function check(current: string) {
		phase = 'checking';
		error = '';
		try {
			preview = await previewSlackLink(current);
			phase = 'confirm';
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't read this link";
			if (e instanceof IntegrationError && e.status === 400) {
				forgetUrlSecret('link:slack');
				phase = 'expired';
			} else {
				phase = 'error';
			}
		}
	}

	async function confirm() {
		if (!token || !preview || phase === 'linking') return;
		phase = 'linking';
		error = '';
		try {
			await linkSlack(token);
			forgetUrlSecret('link:slack');
			phase = 'done';
		} catch (e) {
			error = e instanceof Error ? e.message : "Couldn't link Slack";
			phase = 'confirm';
		}
	}
</script>

<div class="page">
	<section class="card" aria-labelledby="slack-link-title" aria-busy={phase === 'checking'}>
		<span class="mark"><MessageSquare size={20} strokeWidth={1.75} /></span>
		{#if phase === 'done'}
			<h1 class="title" id="slack-link-title">
				<span class="ok"><CircleCheck size={20} strokeWidth={1.75} /></span> Slack is linked
			</h1>
			<p class="text">
				{slackUser} in {slackTeam} now acts as {who ?? 'you'}. Run
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
		{:else if phase === 'expired'}
			<h1 class="title" id="slack-link-title">This link has expired</h1>
			<p class="text">
				It was already used or is more than 10 minutes old. Run
				<span class="code">/greenhouse link</span> in Slack for a new one.
			</p>
		{:else if phase === 'error'}
			<h1 class="title" id="slack-link-title">Couldn't read this link</h1>
			<Alert tone="error" title="Nothing was linked">{error}</Alert>
			<div class="actions">
				<Button variant="secondary" href="/">Cancel</Button>
				<Button variant="primary" onclick={() => token && check(token)}>Try again</Button>
			</div>
		{:else}
			<h1 class="title" id="slack-link-title">Link your Slack account</h1>
			{#if phase === 'checking' || !preview}
				<div class="account" aria-hidden="true">
					<Skeleton height="0.75rem" width="9rem" />
					<Skeleton height="0.625rem" width="6rem" />
				</div>
			{:else}
				<div class="account">
					<span class="account-name">{slackUser}</span>
					<span class="account-team">{slackTeam} on Slack</span>
				</div>
			{/if}
			<p class="text">
				This Slack account asked to act as {who ? `${who} on Orchard` : 'your Orchard account'}.
				Sessions it starts with <span class="code">/greenhouse</span> run on your machines and as you.
			</p>
			<p class="note">
				Only confirm if this is your Slack account and you ran the command yourself.
			</p>
			{#if error}
				<Alert tone="error" title="Not linked">{error}</Alert>
			{/if}
			<div class="actions">
				<Button variant="secondary" href="/">Cancel</Button>
				<Button
					variant="primary"
					loading={phase === 'linking'}
					disabled={phase !== 'confirm' || !preview}
					onclick={confirm}
				>
					Link {preview ? slackUser : 'Slack account'}
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

	.account {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--fill-quiet);
	}

	.account-name {
		font-size: var(--text-footnote);
		line-height: 1.25rem;
		font-weight: 600;
		color: var(--text-default);
	}

	.account-team {
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
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
