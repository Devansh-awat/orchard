<script lang="ts">
	import AuthShell from '$lib/components/patterns/AuthShell.svelte';
	import { SignInFlow } from '$lib/components/login';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { VARIANTS, type VariantKey } from './fixtures';

	let key = $state<VariantKey>('instance');
	let bloom = $state(false);
	let landed = $state(false);
	let hero = $state(true);
	let guides = $state(false);
	let run = $state(0);
	const v = $derived(VARIANTS[key]);

	function replay() {
		bloom = false;
		landed = false;
		run++;
	}

	async function landed_(_message: string, _user: unknown, settle: Promise<void>) {
		await settle;
		await new Promise((r) => setTimeout(r, 900));
		replay();
	}
</script>

{#snippet wordmark()}
	{#if key === 'org'}
		<span class="org">N</span><span class="org-name">Northwind</span>
	{:else}
		<img src="/logo/logofulldm.svg" alt="Orchard" />
	{/if}
{/snippet}

{#snippet pitch()}
	{#if key === 'org'}sign in to <em>Northwind</em>.{:else}sign in to your <em>own</em> cloud.{/if}
{/snippet}

{#snippet mark()}
	{#if key === 'org'}
		<span class="org">N</span>
	{:else}
		<img class="mark" src="/logo/logoiconcolor.svg" alt="Orchard" />
	{/if}
{/snippet}

{#key `${key}:${run}:${hero}`}
	<AuthShell
		{bloom}
		{landed}
		{guides}
		brand={v.brand}
		headline={hero ? pitch : undefined}
		wordmark={hero ? wordmark : undefined}
		tagline={hero && key === 'org' ? 'Northwind engineering' : null}
	>
		<SignInFlow
			title={hero ? 'Sign in' : v.title}
			subtitle="orchard.my"
			mark={hero ? undefined : mark}
			providers={[...v.providers]}
			emailAccess={v.emailAccess}
			revealLabel={key === 'org' ? 'Sign in with email instead' : 'Sign in as an administrator'}
			policy={key === 'enforced' ? 'This instance requires single sign-on.' : undefined}
			bind:bloom
			bind:landed
			onAuthenticated={landed_}
		/>
	</AuthShell>
{/key}

<div class="bar">
	<SegmentedControl
		size="sm"
		label="Variant"
		bind:value={key}
		options={Object.entries(VARIANTS).map(([value, x]) => ({ value, label: x.label }))}
	/>
	<Button size="sm" variant="ghost" onclick={() => (hero = !hero)}
		>{hero ? 'No hero' : 'Hero'}</Button
	>
	<Button size="sm" variant={guides ? 'tinted' : 'ghost'} onclick={() => (guides = !guides)}
		>Guides</Button
	>
	<Button size="sm" variant="secondary" onclick={() => (bloom = true)}>Bloom</Button>
	<Button size="sm" variant="ghost" onclick={replay}>Replay</Button>
</div>

<style>
	.bar {
		position: fixed;
		left: 50%;
		bottom: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem;
		border-radius: calc(0.875rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow:
			0 0 0 0.5px var(--rule-strong),
			var(--shadow-floating);
		transform: translateX(-50%);
	}
	.mark,
	.org {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: calc(0.625rem * var(--corner-scale));
		corner-shape: var(--corner);
		box-shadow: 0 0 0 0.5px var(--rule);
	}
	.org-name {
		font-size: var(--text-headline);
		font-weight: var(--weight-semibold);
	}
	.org {
		background: color-mix(in oklab, var(--on-brand) 18%, var(--accent-solid));
		color: var(--on-solid);
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
	}
</style>
