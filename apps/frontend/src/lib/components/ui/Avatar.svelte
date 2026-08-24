<script lang="ts">
	// A user's picture, at a size. There is always something to show: an
	// uploaded image if there is one, otherwise the mascot `avatarUrl` derives
	// from the user's id. The initial sits underneath as a base layer purely so
	// a failed image request degrades to a letter instead of a hole.
	import RemoteImg from './RemoteImg.svelte';
	import { avatarUrl, avatarFilter, avatarInitial, type AvatarUser } from '$lib/avatar';

	let {
		user,
		size = 32,
		shape = 'circle',
		class: klass = '',
		alt = undefined
	}: {
		user: AvatarUser | null | undefined;
		size?: number;
		shape?: 'circle' | 'rounded';
		class?: string;
		alt?: string;
	} = $props();

	const src = $derived(avatarUrl(user));
	const filter = $derived(avatarFilter(user));
	const initial = $derived(avatarInitial(user));
	const label = $derived(alt ?? `${user?.name || user?.username || user?.email || 'User'} avatar`);
</script>

<span
	class="ui-avatar {klass}"
	class:ui-avatar--rounded={shape === 'rounded'}
	style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.42)}px;"
>
	<span class="ui-avatar-fb" aria-hidden="true">{initial}</span>
	<RemoteImg
		{src}
		alt={label}
		class="ui-avatar-img"
		style={filter ? `filter: ${filter}` : undefined}
	/>
</span>

<style>
	.ui-avatar {
		position: relative;
		display: inline-grid;
		place-items: center;
		flex-shrink: 0;
		overflow: hidden;
		border-radius: 50%;
		background-color: var(--bg-sunken);
	}
	.ui-avatar--rounded {
		border-radius: var(--radius-md);
	}
	.ui-avatar-fb {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		font-weight: 600;
		color: var(--text-muted);
		line-height: 1;
	}
	.ui-avatar :global(.ui-avatar-img) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
