<script lang="ts">
	import type { Icon } from './types';

	let {
		value = $bindable(''),
		error = false,
		icon = undefined,
		size = 'md',
		class: className = '',
		...rest
	}: {
		value?: string | number | null;
		error?: boolean;
		icon?: Icon;
		size?: 'md' | 'sm';
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

{#if icon}
	{@const Leading = icon}
	<span class="wrap {className}">
		<span class="lead" aria-hidden="true"><Leading size={14} /></span>
		<input
			class="control control--{size} control--lead"
			class:control--error={error}
			aria-invalid={error || undefined}
			bind:value
			{...rest}
		/>
	</span>
{:else}
	<input
		class="control control--{size} {className}"
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
		left: 0.625rem;
		display: flex;
		color: var(--text-faint);
		transform: translateY(-50%);
		pointer-events: none;
	}
	.control {
		display: block;
		width: 100%;
		min-width: 0;
		height: 2rem;
		padding: 0 0.625rem;
		border: none;
		border-radius: var(--radius-control);
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--border-default);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		transition:
			box-shadow var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.control--sm {
		height: 1.75rem;
		font-size: var(--text-callout);
	}
	.control--lead {
		padding-left: 2rem;
	}
	.control::placeholder {
		color: var(--text-faint);
	}
	.control:hover:not(:disabled) {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.control:focus {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--accent),
			0 0 0 3px var(--focus-ring);
	}
	.control--error,
	.control--error:hover {
		box-shadow: inset 0 0 0 1px var(--red-7);
	}
	.control--error:focus {
		box-shadow:
			inset 0 0 0 1px var(--red-7),
			0 0 0 3px color-mix(in oklab, var(--red-7) 24%, transparent);
	}
	.control:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	textarea.control {
		height: auto;
		padding: 0.5rem 0.625rem;
	}
</style>
