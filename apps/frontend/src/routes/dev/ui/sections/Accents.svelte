<script lang="ts">
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import AsciiVine from '$lib/components/ui/AsciiVine.svelte';
	import CodeInput from '$lib/components/ui/CodeInput.svelte';
	import Verdict from './Verdict.svelte';

	let bloom = $state(false);
	let run = $state(0);
	let code = $state('');
	let wrong = $state(false);

	const RULES = [
		{ rule: 'One per screen', detail: 'The vine is the only flourish on the screen it lives on.' },
		{
			rule: 'Arrival moments only',
			detail: 'Sign-in, the updates sheet, a first empty project. Never on a working screen.'
		},
		{
			rule: 'Behind surfaces, never behind text',
			detail: 'It threads under a solid sheet. Copy sits on the sheet, not on the vine.'
		},
		{
			rule: 'Grows once, blooms on success',
			detail: 'It grows on arrival and sways. bloom flowers it when the thing you came for worked.'
		},
		{
			rule: 'Ink follows the accent',
			detail:
				'Stem, leaves and petals read --accent-6 to --accent-10, so org branding recolours it.'
		},
		{
			rule: 'Decoration tier',
			detail:
				'Below full motion it is drawn grown and still. It pauses off screen and in hidden tabs.'
		}
	];

	$effect(() => {
		if (code.length < 6) wrong = false;
	});

	function check(value: string) {
		wrong = value === '000000';
	}
</script>

<SectionCard
	title="The vine"
	description="Orchard's one ornament: an ASCII vine that grows, sways and blooms. Monospace glyphs on a canvas, 14 frames a second on purpose."
>
	{#snippet actions()}
		<div class="flex items-center gap-2">
			<Button size="sm" variant="secondary" onclick={() => (bloom = true)}>Bloom</Button>
			<Button
				size="sm"
				variant="ghost"
				onclick={() => {
					bloom = false;
					run++;
				}}>Replay</Button
			>
		</div>
	{/snippet}
	<div class="flex flex-col gap-6">
		<div class="plot">
			{#key run}<AsciiVine seed={23} band={[0.3, 0.7]} {bloom} />{/key}
			<div class="card">
				<p class="card-title">Behind a sheet</p>
				<p class="card-sub">The stem threads under solid surfaces and blooms either side.</p>
			</div>
		</div>
		<div class="rules">
			{#each RULES as r (r.rule)}
				<div>
					<p class="rule">{r.rule}</p>
					<p class="detail">{r.detail}</p>
				</div>
			{/each}
		</div>
		<div class="grid grid-cols-2 gap-4">
			<Verdict kind="do" note="Under a solid surface, copy on the surface.">
				<div class="mini">
					<AsciiVine seed={11} band={[0.35, 0.7]} />
					<span class="mini-card">Sign in</span>
				</div>
			</Verdict>
			<Verdict kind="dont" note="Text straight on the vine, or two flourishes fighting.">
				<div class="mini">
					<AsciiVine seed={11} band={[0.35, 0.7]} />
					<span class="mini-text">Welcome back</span>
				</div>
			</Verdict>
		</div>
	</div>
</SectionCard>

<SectionCard
	title="One-time code"
	description="CodeInput is one real input under six cells, so paste, autofill and screen readers see a normal field. It submits itself at the last digit and shakes when the code is wrong."
>
	<div class="code-demo">
		<CodeInput bind:value={code} error={wrong} oncomplete={check} />
		<p class="detail">Type any code. 000000 is the wrong one.</p>
	</div>
</SectionCard>

<style>
	.plot {
		position: relative;
		display: grid;
		place-items: center;
		height: 18rem;
		overflow: hidden;
		border-radius: calc(var(--radius-card) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-app);
		box-shadow: inset 0 0 0 0.5px var(--rule);
	}
	.plot > :global(canvas) {
		position: absolute;
		inset: 0;
	}
	.card {
		position: relative;
		width: 16rem;
		padding: 1.25rem;
		border-radius: calc((0.75rem + 1.25rem) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow:
			0 0 0 0.5px var(--rule-strong),
			var(--shadow-floating);
	}
	.card-title {
		font-size: var(--text-headline);
		line-height: var(--lh-headline);
		font-weight: var(--weight-semibold);
	}
	.card-sub,
	.detail {
		font-size: var(--text-callout);
		line-height: var(--lh-callout);
		color: var(--text-muted);
	}
	.rules {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem 1.5rem;
	}
	.rule {
		font-size: var(--text-body);
		line-height: var(--lh-body);
		font-weight: var(--weight-medium);
	}
	.mini {
		position: relative;
		display: grid;
		place-items: center;
		width: 100%;
		height: 8rem;
		overflow: hidden;
	}
	.mini > :global(canvas) {
		position: absolute;
		inset: 0;
	}
	.mini-card {
		position: relative;
		padding: 0.5rem 1rem;
		border-radius: calc(0.75rem * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-surface);
		box-shadow: var(--shadow-raised);
		font-size: var(--text-callout);
		font-weight: var(--weight-medium);
	}
	.mini-text {
		position: relative;
		font-size: var(--text-title-3);
		font-weight: var(--weight-semibold);
	}
	.code-demo {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 20rem;
	}
</style>
