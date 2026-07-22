<script lang="ts">
	import { ChevronDown, Plus } from 'lucide-svelte';
	import { PopoverPanel } from '$lib/components/ui';

	let {
		accounts = [],
		selected = null,
		onSelect,
		installUrl = null
	}: {
		accounts?: { login: string; count: number }[];
		selected?: string | null;
		onSelect: (login: string) => void;
		installUrl?: string | null;
	} = $props();
</script>

<PopoverPanel sameWidth>
	{#snippet trigger(attrs, open)}
		<button type="button" class="acct-trigger" {...attrs}>
			{#if selected}
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
					class:acct-option--active={account.login === selected}
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
		padding: 0 0.625rem;
		border-radius: 0.5rem;
		border: 1px solid var(--border-default);
		background: var(--bg-raised);
		color: var(--text-default);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.acct-trigger:hover {
		border-color: var(--border-strong);
	}

	.acct-avatar {
		width: 1.125rem;
		height: 1.125rem;
		border-radius: 0.25rem;
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
		font-weight: 500;
		text-align: left;
	}

	.acct-chevron {
		display: inline-flex;
		color: var(--text-muted);
		transition: transform 0.15s ease;
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
		padding: 0.4375rem 0.5rem;
		border: none;
		border-radius: 0.375rem;
		background: transparent;
		color: var(--text-default);
		font-size: 0.8125rem;
		font-weight: 500;
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
		font-size: 0.6875rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.acct-empty {
		padding: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.acct-add {
		margin-top: 0.125rem;
		border-top: 1px solid var(--border-default);
		border-radius: 0 0 0.375rem 0.375rem;
		color: var(--text-muted);
	}

	.acct-add-icon {
		display: inline-flex;
		width: 1.125rem;
		justify-content: center;
	}
</style>
