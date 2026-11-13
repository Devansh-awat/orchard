<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { ArrowDown } from 'lucide-svelte';
	import HackClubFlag from './HackClubFlag.svelte';
	import { links } from '$lib/links';

	let {
		class: className = '',
		explain,
		...rest
	}: HTMLAttributes<HTMLParagraphElement> & { explain?: string } = $props();
</script>

<p class="credit {className}" class:with-explain={explain} {...rest}>
	<span class="who">
		A <a href={links.hackclub} class="flag" aria-label="Hack Club"
			><HackClubFlag class="h-[26px] w-auto" /></a
		>
		project, created by <a href={links.author}>Leafd</a>
	</span>
	{#if explain}
		<a href={explain} class="what">
			<span class="what-label">What is Hack Club?</span>
			<ArrowDown size={16} strokeWidth={2.25} aria-hidden="true" />
		</a>
	{/if}
</p>

<style>
	.credit {
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		border-radius: 999px;
		background: rgb(195 16 38 / 0.35);
		padding: 0.5rem 1.1rem;
		font-size: 1rem;
		color: rgb(255 255 248 / 0.9);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16);
	}

	.credit.with-explain {
		padding: 0.375rem 0.375rem 0.375rem 1.1rem;
	}

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.3em;
		white-space: nowrap;
	}

	.who a {
		font-weight: 600;
		color: #fff;
		text-decoration: underline;
		text-decoration-color: rgb(255 255 255 / 0.4);
		text-underline-offset: 3px;
		transition: text-decoration-color 0.2s ease;
	}

	.who a:hover {
		text-decoration-color: #fff;
	}

	.who .flag {
		display: inline-flex;
		margin-inline: 0.1em;
		color: #fff;
		text-decoration: none;
		transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.who .flag:hover {
		transform: rotate(-6deg) scale(1.06);
	}

	.what {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.16);
		padding: 0.375rem 0.875rem;
		font-weight: 600;
		white-space: nowrap;
		color: #fff;
		transition: background-color 0.2s ease;
	}

	.what :global(svg) {
		transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.what:hover {
		background: rgb(255 255 255 / 0.26);
	}

	.what:hover :global(svg) {
		transform: translateY(2px);
	}

	.credit a:focus-visible {
		outline: 2px solid var(--color-cream);
		outline-offset: 2px;
		border-radius: 999px;
	}

	@media (max-width: 639px) {
		.credit {
			flex-wrap: nowrap;
			gap: 0.5rem;
			font-size: 0.8125rem;
		}

		.credit.with-explain {
			padding: 0.25rem 0.25rem 0.25rem 0.75rem;
		}

		.who :global(svg) {
			height: 19px;
		}

		.what {
			width: 1.75rem;
			height: 1.75rem;
			padding: 0;
			justify-content: center;
		}

		.what-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

	@media (max-width: 359px) {
		.credit {
			font-size: 0.75rem;
		}

		.who :global(svg) {
			height: 17px;
		}
	}
</style>
