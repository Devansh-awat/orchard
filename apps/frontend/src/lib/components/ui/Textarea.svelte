<script lang="ts">
	let {
		value = $bindable(''),
		rows = 3,
		autoGrow = false,
		maxRows = 12,
		error = false,
		mono = false,
		maxlength = undefined,
		counter = false,
		class: className = '',
		...rest
	}: {
		value?: string | null;
		rows?: number;
		autoGrow?: boolean;
		maxRows?: number;
		error?: boolean;
		mono?: boolean;
		maxlength?: number;
		counter?: boolean;
		class?: string;
		[key: string]: unknown;
	} = $props();

	let el = $state<HTMLTextAreaElement | null>(null);
	const length = $derived((value ?? '').length);
	const near = $derived(maxlength != null && length >= maxlength * 0.9);

	function fit() {
		if (!el || !autoGrow) return;
		const style = getComputedStyle(el);
		const line = parseFloat(style.lineHeight) || 20;
		const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
		const cap = line * maxRows + pad;
		el.style.height = 'auto';
		const next = Math.min(el.scrollHeight, cap);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
	}

	$effect(() => {
		void value;
		fit();
	});
</script>

<span class="wrap {className}" class:wrap--counter={counter && maxlength != null}>
	<textarea
		bind:this={el}
		bind:value
		{rows}
		{maxlength}
		class="area"
		class:area--error={error}
		class:area--mono={mono}
		class:area--grow={autoGrow}
		aria-invalid={error || undefined}
		{...rest}></textarea>
	{#if counter && maxlength != null}
		<span class="count" class:count--near={near} aria-hidden="true">{length}/{maxlength}</span>
	{/if}
</span>

<style>
	.wrap {
		position: relative;
		display: block;
		min-width: 0;
	}
	.area {
		display: block;
		width: 100%;
		min-width: 0;
		min-height: 2rem;
		padding: 0.375rem 0.625rem;
		border: none;
		border-radius: calc(var(--radius-control) * var(--corner-scale));
		corner-shape: var(--corner);
		background: var(--bg-raised);
		box-shadow: inset 0 0 0 1px var(--border-default);
		color: var(--text-default);
		font: inherit;
		font-size: var(--text-body);
		line-height: var(--lh-body);
		resize: vertical;
		transition:
			box-shadow var(--dur-fast) ease,
			background-color var(--dur-fast) ease;
	}
	.area--grow {
		resize: none;
		overflow-y: hidden;
	}
	.area--mono {
		font-family: var(--font-mono);
		font-size: var(--text-callout);
		line-height: var(--lh-body);
	}
	.wrap--counter .area {
		padding-bottom: 1.5rem;
	}
	.area::placeholder {
		color: var(--text-faint);
	}
	.area:hover:not(:disabled) {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.area:focus {
		outline: none;
		box-shadow:
			inset 0 0 0 1px var(--accent),
			0 0 0 3px var(--focus-ring);
	}
	.area--error,
	.area--error:hover:not(:disabled) {
		box-shadow: inset 0 0 0 1px var(--red-7);
	}
	.area--error:focus {
		box-shadow:
			inset 0 0 0 1px var(--red-7),
			0 0 0 3px color-mix(in oklab, var(--red-7) 24%, transparent);
	}
	.area:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		resize: none;
	}
	.count {
		position: absolute;
		right: 0.625rem;
		bottom: 0.5rem;
		font-size: var(--text-caption);
		line-height: 1;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		pointer-events: none;
		text-box: trim-both cap alphabetic;
	}
	.count--near {
		color: var(--status-warning);
	}
</style>
