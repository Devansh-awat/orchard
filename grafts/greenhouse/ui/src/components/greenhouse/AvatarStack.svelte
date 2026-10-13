<script lang="ts">
	import Avatar from '@orchard/graft-ui/components/ui/Avatar.svelte';
	import { presenceColorVar } from './format';
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

	const ordered = $derived(
		hostBadge
			? [...users].sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
			: users
	);
	const shown = $derived(ordered.slice(0, max));
	const extra = $derived(Math.max(0, users.length - max));
</script>

{#if users.length > 0}
	<div
		class="stack"
		class:stack--buttons={!!onpick}
		style="--av: {size}px"
		role="group"
		aria-label="People here"
		data-align="stack"
	>
		{#each shown as user (user.id)}
			{#if onpick}
				<button
					type="button"
					class="face"
					class:face--following={following === user.id}
					style="--ring: var({presenceColorVar(user)})"
					title={following === user.id ? `Following ${user.name}` : `Follow ${user.name}`}
					aria-label={following === user.id ? `Stop following ${user.name}` : `Follow ${user.name}`}
					aria-pressed={following === user.id}
					onclick={() => onpick?.(user)}
				>
					<span class="disc gh-face"
						><Avatar
							user={{ id: user.id, name: user.name, imageUrl: user.avatarUrl }}
							{size}
						/></span
					>
				</button>
			{:else}
				<span class="face" style="--ring: var({presenceColorVar(user)})" title={user.name}>
					<span class="disc gh-face"
						><Avatar
							user={{ id: user.id, name: user.name, imageUrl: user.avatarUrl }}
							{size}
						/></span
					>
				</span>
			{/if}
			{#if hostBadge && user.role === 'owner'}<span class="host" title="{user.name} is the host"
					>Host</span
				>{/if}
		{/each}
		{#if extra > 0}
			<span
				class="more"
				title={ordered
					.slice(max)
					.map((u) => u.name)
					.join(', ')}>+{extra}</span
			>
		{/if}
	</div>
{/if}

<style>
	.stack {
		--hit: var(--av);
		display: inline-flex;
		align-items: center;
		flex: none;
	}

	.stack--buttons {
		--hit: max(var(--av), var(--gh-icon, 1.75rem));
	}

	.face {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--hit);
		height: var(--hit);
		border-radius: var(--radius-pill);
	}

	.face + .face,
	.face + .more {
		margin-left: calc(var(--av) * 0.72 - var(--hit));
	}

	.host + .face,
	.host + .more {
		margin-left: 0;
	}

	.disc {
		--face: var(--av);
		display: inline-grid;
		place-items: center;
		width: var(--av);
		height: var(--av);
		border-radius: var(--radius-pill);
		box-shadow: 0 0 0 1.5px var(--stack-ring, var(--gh-editor, var(--bg-app)));
		overflow: hidden;
	}

	button.face {
		cursor: pointer;
	}

	button.face:hover,
	.face--following {
		z-index: 1;
	}

	button.face:hover .disc,
	.face--following .disc {
		box-shadow:
			0 0 0 1.5px var(--stack-ring, var(--gh-editor, var(--bg-app))),
			0 0 0 3px var(--ring);
	}

	button.face:focus-visible {
		outline: none;
	}

	button.face:focus-visible .disc {
		box-shadow:
			0 0 0 1.5px var(--stack-ring, var(--gh-editor, var(--bg-app))),
			0 0 0 3px var(--focus-ring-color);
	}

	.host {
		position: relative;
		z-index: 2;
		margin: 0 0.5rem 0 0.25rem;
		font-size: var(--text-caption);
		line-height: 1rem;
		color: var(--text-muted);
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
		line-height: 1rem;
		box-shadow: 0 0 0 1.5px var(--stack-ring, var(--gh-editor, var(--bg-app)));
	}
</style>
