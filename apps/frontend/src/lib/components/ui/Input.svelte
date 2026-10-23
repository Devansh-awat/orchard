<script lang="ts">
	import type { Icon } from './types';

	let {
		value = $bindable(''),
		error = false,
		icon = undefined,
		size = 'md',
		shape = 'rounded',
		class: className = '',
		...rest
	}: {
		value?: string | number | null;
		error?: boolean;
		icon?: Icon;
		size?: 'md' | 'sm';
		shape?: 'rounded' | 'capsule';
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

{#if icon}
	{@const Leading = icon}
	<span class="wrap {className}">
		<span class="lead" aria-hidden="true"><Leading size={15} /></span>
		<input
			class="control control--{size} control--{shape} control--lead"
			class:control--error={error}
			aria-invalid={error || undefined}
			bind:value
			{...rest}
		/>
	</span>
{:else}
	<input
		class="control control--{size} control--{shape} {className}"
		class:control--error={error}
		aria-invalid={error || undefined}
		bind:value
		{...rest}
	/>
{/if}

<style>
	.wrap {
		position: relative;
		display: block;
		min-width: 0;
	}
	.lead {
		position: absolute;
		top: 50%;
		left: 0.75rem;
		display: flex;
		color: var(--text-muted);
		transform: translateY(-50%);
		pointer-events: none;
	}
	.control {
		display: block;
		width: 100%;
		min-width: 0;
		height: 2rem;
		padding: 0 0.6875rem;
		border: none;
		border-radius: var(--radius-control);
		corner-shape: var(--corner);
		background: color-mix(in oklab, var(--neutral-10) 6%, transparent);
		box-shadow: inset 0 0 0 0.5px color-mix(in oklab, var(--neutral-10) 6%, transparent);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		transition:
			box-shadow var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.control--capsule {
		border-radius: var(--radius-control);
		corner-shape: var(--corner);
	}
	.control--sm {
		height: 1.75rem;
		border-radius: 0.5rem;
		corner-shape: var(--corner);
		font-size: var(--text-callout);
	}
	.control--sm.control--capsule {
		border-radius: 0.5rem;
		corner-shape: var(--corner);
	}
	.control--lead {
		padding-left: 2.125rem;
	}
	.control::placeholder {
		color: var(--text-muted);
	}
	.control:hover:not(:disabled):not(:focus) {
		background: color-mix(in oklab, var(--neutral-10) 8%, transparent);
	}
	.control:focus {
		outline: none;
		background: var(--bg-surface);
		box-shadow:
			inset 0 0 0 1px var(--accent-solid),
			0 0 0 3.5px color-mix(in oklab, var(--accent-solid) 22%, transparent);
	}
	.control--error,
	.control--error:hover:not(:focus) {
		background: color-mix(in oklab, var(--red-solid) 7%, transparent);
		box-shadow: inset 0 0 0 1px var(--red-6);
	}
	.control--error:focus {
		box-shadow:
			inset 0 0 0 1px var(--red-solid),
			0 0 0 3.5px color-mix(in oklab, var(--red-solid) 22%, transparent);
	}
	.control:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	textarea.control {
		height: auto;
		padding: 0.5rem 0.75rem;
	}
</style>
