<script lang="ts">
	import AuthShell from '$lib/components/patterns/AuthShell.svelte';
	import { SignInFlow } from '$lib/components/login';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import { VARIANTS, type VariantKey } from './fixtures';

	let key = $state<VariantKey>('instance');
	let bloom = $state(false);
	let run = $state(0);
	const v = $derived(VARIANTS[key]);

	function replay() {
		bloom = false;
		run++;
	}

	async function landed(_message: string, _user: unknown, settle: Promise<void>) {
		await settle;
		await new Promise((r) => setTimeout(r, 900));
		replay();
	}
</script>

{#key `${key}:${run}`}
	<AuthShell {bloom} brand={v.brand}>
		<SignInFlow
			title={v.title}
			subtitle={key === 'org' ? 'Northwind engineering' : 'orchard.my'}
			providers={[...v.providers]}
			emailAccess={v.emailAccess}
			revealLabel={key === 'org' ? 'Sign in with email instead' : 'Sign in as an administrator'}
			policy={key === 'enforced' ? 'This instance requires single sign-on.' : undefined}
			bind:bloom
			onAuthenticated={landed}
		>
			{#snippet mark()}
				{#if key === 'org'}
					<span class="org">N</span>
				{:else}
					<img class="mark" src="/logo/logoiconcolor.svg" alt="Orchard" />
				{/if}
			{/snippet}
		</SignInFlow>
	</AuthShell>
{/key}

<div class="bar">
	<SegmentedControl
		size="sm"
		label="Variant"
		bind:value={key}
		options={Object.entries(VARIANTS).map(([value, x]) => ({ value, label: x.label }))}
	/>
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
	.org {
		background: var(--accent-solid);
		color: var(--on-solid);
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
	}
</style>
