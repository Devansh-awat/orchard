<script lang="ts" module>
	// Hoisted so the fallback is the same function every render. Inline, the
	// `??` would mint a new one whenever any prop changed, and an attachment
	// whose identity changes is torn down and re-run - which for the one caller
	// that does pass a gaze would mean rebuilding the driver, with the eyes
	// snapping back to centre each time.
	const noAttachment = () => {};
</script>

<script lang="ts">
	// A user's picture. There is always something to show: their upload if they
	// have one, otherwise the blobatar drawn from their id.
	//
	// It renders exactly one element and forwards `class` and `style` onto it,
	// so a caller styles it the way they already styled the `<img>` this
	// replaced. That is the whole reason there is no wrapper here.
	//
	// `alive` is what costs something. A still blobatar is one `<img>` and an
	// animated one is inline SVG - roughly a dozen nodes - because host CSS
	// cannot reach inside an `<img>` and `:hover` is what drives the idle loop.
	// So it is opt-in per call site rather than a default, and the long lists
	// (admin users, the grove feed, quick search) deliberately leave it off.
	//
	// `mood` is free either way. A pose is baked into the static markup too, so
	// an invited-but-not-arrived member still reads as asleep in a list that
	// never animates.
	import { Blobatar } from '@blobatar/svelte';
	import type { GazeAttachment } from '@blobatar/svelte/gaze';
	import RemoteImg from './RemoteImg.svelte';
	import { AVATAR_OPTIONS, avatarSeed, moodPose, type AvatarUser, type Mood } from '$lib/avatar';

	let {
		user,
		seed = undefined,
		mood = 'idle',
		alive = false,
		eyes = undefined,
		size = undefined,
		alt = '',
		class: klass = '',
		style = undefined,
		loading = undefined
	}: {
		user?: AvatarUser | null;
		seed?: string;
		mood?: Mood;
		alive?: boolean | 'always';
		eyes?: GazeAttachment;
		size?: number;
		alt?: string;
		class?: string;
		style?: string;
		loading?: 'eager' | 'lazy';
	} = $props();

	const name = $derived(seed || avatarSeed(user));
	const expression = $derived(moodPose(mood));
	// Handed to the library in its own vocabulary rather than as a boolean, so a
	// profile header choosing continuous motion is choosing it by name.
	const animate = $derived(alive === 'always' ? 'always' : alive ? 'hover' : false);
	const cls = $derived(klass ? `ui-avatar ${klass}` : 'ui-avatar');
	const sized = $derived(
		size ? `width:${size}px;height:${size}px;${style ?? ''}` : (style ?? undefined)
	);
</script>

{#if user?.imageUrl}
	<RemoteImg src={user.imageUrl} {alt} class={cls} style={sized} eager={loading !== 'lazy'} />
{:else if animate}
	<Blobatar
		{name}
		{...AVATAR_OPTIONS}
		{animate}
		{expression}
		{size}
		title={alt || undefined}
		class={cls}
		{style}
		{@attach eyes ?? noAttachment}
	/>
{:else}
	<Blobatar {name} {...AVATAR_OPTIONS} {expression} {size} {alt} class={cls} {style} {loading} />
{/if}

<style>
	:global(:where(.ui-avatar)) {
		flex-shrink: 0;
		border-radius: 50%;
		object-fit: cover;
		outline: 0.5px solid color-mix(in oklab, var(--neutral-10) 12%, transparent);
		outline-offset: -0.5px;
	}
</style>
