<script lang="ts">
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import type { RosterUser } from './types';

	let {
		users,
		max = 3,
		size = 20,
		following = null,
		onpick = undefined,
		hostBadge = true
	}: {
		users: readonly RosterUser[];
		max?: number;
		size?: number;
		following?: string | null;
		onpick?: (user: RosterUser) => void;
		hostBadge?: boolean;
	} = $props();

	const shown = $derived(users.slice(0, max));
	const extra = $derived(Math.max(0, users.length - max));
</script>

{#if users.length > 0}
	<div class="stack" style="--av: {size}px" role="group" aria-label="People here">
		{#each shown as user (user.id)}
			{#if onpick}
				<button
					type="button"
					class="face"
					class:face--following={following === user.id}
					style="--ring: var({user.color?.startsWith('--') ? user.color : '--accent'})"
					title={following === user.id ? `Following ${user.name}` : `Follow ${user.name}`}
					aria-pressed={following === user.id}
					onclick={() => onpick?.(user)}
				>
					<Avatar user={{ id: user.id, name: user.name, imageUrl: user.avatarUrl }} {size} />
				</button>
				{#if hostBadge && user.role === 'owner'}<span class="host" title="{user.name} is the host"
						>Host</span
					>{/if}
			{:else}
				<span
					class="face"
					style="--ring: var({user.color?.startsWith('--') ? user.color : '--accent'})"
					title={user.name}
				>
					<Avatar user={{ id: user.id, name: user.name, imageUrl: user.avatarUrl }} {size} />
				</span>
				{#if hostBadge && user.role === 'owner'}<span class="host" title="{user.name} is the host"
						>Host</span
					>{/if}
			{/if}
		{/each}
		{#if extra > 0}
			<span
				class="more"
				title={users
					.slice(max)
					.map((u) => u.name)
					.join(', ')}>+{extra}</span
			>
		{/if}
	</div>
{/if}

<style>
	.stack {
		display: inline-flex;
		align-items: center;
		flex: none;
	}

	.face {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: var(--av);
		height: var(--av);
		border-radius: var(--radius-pill);
		box-shadow: 0 0 0 1.5px var(--gh-editor, var(--bg-app));
		overflow: hidden;
	}

	.face + .face,
	.face + .more {
		margin-left: calc(var(--av) * -0.28);
	}

	button.face {
		cursor: pointer;
	}

	button.face:hover,
	.face--following {
		box-shadow:
			0 0 0 1.5px var(--gh-editor, var(--bg-app)),
			0 0 0 3px var(--ring);
		z-index: 1;
	}

	.host {
		position: relative;
		z-index: 2;
		margin: 0 0.375rem 0 0.25rem;
		padding: 0 0.3125rem;
		border-radius: var(--radius-pill);
		background: color-mix(in oklab, var(--accent) 14%, transparent);
		color: var(--accent);
		font-size: var(--text-micro);
		font-weight: 600;
		line-height: 1.5;
	}

	.more {
		display: inline-grid;
		place-items: center;
		min-width: var(--av);
		height: var(--av);
		padding: 0 0.25rem;
		border-radius: var(--radius-pill);
		background: var(--gh-selected);
		color: var(--gh-muted);
		font-size: var(--text-micro);
		font-weight: 600;
		box-shadow: 0 0 0 1.5px var(--gh-editor, var(--bg-app));
	}
</style>
