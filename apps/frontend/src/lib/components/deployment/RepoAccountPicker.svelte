<script lang="ts">
	import { ChevronDown, Plus, Link2 } from 'lucide-svelte';
	import { PopoverPanel } from '$lib/components/ui';

	let {
		accounts = [],
		selected = null,
		onSelect,
		installUrl = null,
		directLink = false,
		onDirectLink
	}: {
		accounts?: { login: string; count: number }[];
		selected?: string | null;
		onSelect: (login: string) => void;
		installUrl?: string | null;
		directLink?: boolean;
		onDirectLink?: () => void;
	} = $props();
</script>

<PopoverPanel sameWidth>
	{#snippet trigger(attrs, open)}
		<button type="button" class="acct-trigger" {...attrs}>
			{#if directLink}
				<span class="acct-link-icon"><Link2 size={14} /></span>
				<span class="acct-login">Direct link</span>
			{:else if selected}
				<img class="acct-avatar" src="https://github.com/{selected}.png?size=40" alt="" />
				<span class="acct-login">{selected}</span>
			{:else}
				<span class="acct-placeholder">Account</span>
			{/if}
			<span class="acct-chevron" class:acct-chevron--open={open}><ChevronDown size={14} /></span>
		</button>
	{/snippet}
	{#snippet children({ close })}
		<div class="acct-list">
			{#each accounts as account (account.login)}
				<button
					type="button"
					class="acct-option"
					class:acct-option--active={!directLink && account.login === selected}
					onclick={() => {
						onSelect(account.login);
						close();
					}}
				>
					<img class="acct-avatar" src="https://github.com/{account.login}.png?size=40" alt="" />
					<span class="acct-login">{account.login}</span>
					<span class="acct-count">{account.count}</span>
				</button>
			{:else}
				<div class="acct-empty">No connected accounts yet</div>
			{/each}
			{#if onDirectLink || installUrl}
				<div class="acct-sep"></div>
			{/if}
			{#if onDirectLink}
				<button
					type="button"
					class="acct-option"
					class:acct-option--active={directLink}
					onclick={() => {
						onDirectLink();
						close();
					}}
				>
					<span class="acct-link-icon"><Link2 size={14} /></span>
					<span class="acct-login">Direct link</span>
				</button>
			{/if}
			{#if installUrl}
				<a class="acct-option acct-add" href={installUrl} target="_blank" rel="noopener noreferrer">
					<span class="acct-add-icon"><Plus size={14} /></span>
					<span class="acct-login">Add GitHub account</span>
				</a>
			{/if}
		</div>
	{/snippet}
</PopoverPanel>

<style>
	.acct-trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		height: 2.25rem;
		padding: 0 0.75rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		transition: border-color var(--dur-fast);
	}

	.acct-trigger:hover {
		border-color: var(--border-strong);
	}

	.acct-avatar {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: var(--radius-xs);
		flex-shrink: 0;
	}

	.acct-login {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}

	.acct-placeholder {
		flex: 1;
		color: var(--text-faint);
		font-weight: 600;
		text-align: left;
	}

	.acct-chevron {
		display: inline-flex;
		color: var(--text-muted);
		transition: transform var(--dur-fast) ease;
	}

	.acct-chevron--open {
		transform: rotate(180deg);
	}

	.acct-list {
		display: flex;
		flex-direction: column;
		padding: 0.25rem;
	}

	.acct-option {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.5rem;
		border: none;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-default);
		font-size: var(--text-footnote);
		line-height: var(--lh-footnote);
		font-weight: 600;
		cursor: pointer;
		text-decoration: none;
		text-align: left;
	}

	.acct-option:hover {
		background: var(--accent-subtle);
	}

	.acct-option--active {
		font-weight: 600;
	}

	.acct-count {
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.acct-empty {
		padding: 0.5rem;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-muted);
	}

	.acct-add {
		color: var(--text-muted);
	}

	.acct-sep {
		height: 1px;
		margin: 0.25rem 0.5rem;
		background: var(--border-default);
	}

	.acct-add-icon {
		display: inline-flex;
		width: 1.125rem;
		justify-content: center;
	}

	.acct-link-icon {
		display: inline-flex;
		width: 1.125rem;
		justify-content: center;
		color: var(--text-muted);
		flex-shrink: 0;
	}
</style>
