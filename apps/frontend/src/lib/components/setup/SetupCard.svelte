<script lang="ts">
	import type { Snippet } from 'svelte';
	import { animate } from 'motion';
	import { transition, motionEnabled } from '$lib/utils/motion.svelte';

	let { total, index, children }: { total: number; index: number; children: Snippet } = $props();

	let shell = $state<HTMLElement | null>(null);
	let measured = 0;

	export function grow() {
		if (!shell || !motionEnabled()) return;
		const from = measured || shell.offsetHeight;
		requestAnimationFrame(() => {
			if (!shell) return;
			const to = shell.scrollHeight;
			measured = to;
			if (to === from) return;
			shell.style.height = `${from}px`;
			animate(shell, { height: [from, to] }, transition('smooth')).finished.then(() => {
				if (shell) shell.style.height = '';
			});
		});
	}
</script>

<div class="setup-card-wrap">
	<div class="setup-halo"></div>
	<div class="setup-card" bind:this={shell}>
		<div class="setup-dots">
			{#each Array(total) as _, i (i)}
				<i class:on={i < index} class:now={i === index}></i>
			{/each}
		</div>
		{@render children()}
	</div>
</div>

<style>
	.setup-card-wrap {
		position: relative;
		width: min(27rem, 100%);
		flex: none;
		margin: auto 0;
	}

	.setup-halo {
		position: absolute;
		inset: -16% -14%;
		border-radius: 50%;
		pointer-events: none;
		filter: blur(56px);
		opacity: 0.9;
		background:
			radial-gradient(46% 56% at 20% 30%, var(--setup-glow-rose), transparent 70%),
			radial-gradient(46% 54% at 84% 20%, var(--setup-glow-warm), transparent 70%),
			radial-gradient(54% 52% at 60% 92%, rgba(191, 55, 71, 0.24), transparent 72%);
	}

	.setup-card {
		position: relative;
		overflow: hidden;
		text-align: center;
		padding: 2.4rem 2.2rem 2rem;
		border-radius: 1.5rem;
		background: linear-gradient(168deg, var(--setup-paper) 0%, var(--setup-paper-deep) 100%);
		box-shadow:
			0 1px 0 rgba(255, 255, 255, 0.9) inset,
			0 0 0 1px rgba(42, 35, 32, 0.045),
			0 24px 56px -30px rgba(84, 30, 38, 0.26);
	}

	.setup-card::after {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0.26;
		mix-blend-mode: multiply;
		border-radius: 1.5rem;
		z-index: 3;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='150' height='150'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.92' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='150' height='150' filter='url(%23g)' opacity='.46'/%3E%3C/svg%3E");
	}

	.setup-dots {
		display: flex;
		justify-content: center;
		gap: 0.45rem;
		margin-bottom: 2.1rem;
		position: relative;
		z-index: 2;
	}

	.setup-dots i {
		width: 5px;
		height: 5px;
		border-radius: 999px;
		background: rgba(42, 35, 32, 0.14);
		transition: background-color 0.35s ease;
	}

	.setup-dots i.on {
		background: rgba(42, 35, 32, 0.32);
	}

	.setup-dots i.now {
		background: var(--setup-crimson);
	}

	@media (max-height: 47.5rem) {
		.setup-card {
			padding: 1.8rem 1.9rem 1.5rem;
		}

		.setup-dots {
			margin-bottom: 1.5rem;
		}
	}
</style>
