<script lang="ts">
	import { ChevronDown, Sparkles } from 'lucide-svelte';

	type Parameter = {
		name: string;
		displayName?: string;
		description?: string;
		type?: string;
		default?: unknown;
		required?: boolean;
		placeholder?: string;
		options?: { label: string; value: string }[];
	};

	let { displayName, parameters }: { displayName: string; parameters: Parameter[] } = $props();

	function text(value: unknown) {
		if (value === undefined || value === null || value === '') return '';
		return typeof value === 'string' ? value : JSON.stringify(value);
	}

	function selected(p: Parameter) {
		const match = p.options?.find((o) => o.value === p.default);
		return match?.label ?? p.options?.[0]?.label ?? '';
	}
</script>

<div
	class="form"
	role="img"
	aria-label="The deploy form for {displayName} as it appears in Orchard, with {parameters.length} fields."
>
	<div class="top">
		<p class="title">Deploy {displayName}</p>
	</div>
	<div class="fields">
		{#each parameters as p (p.name)}
			{@const kind = p.type ?? 'string'}
			<div class="field">
				<div class="label">
					<span>{p.displayName ?? p.name}</span>
					{#if p.required}
						<span class="req">required</span>
					{/if}
				</div>
				{#if kind === 'boolean'}
					<div class="switch-row">
						<span class="switch" class:on={p.default === true || p.default === 'true'}>
							<span class="knob"></span>
						</span>
						<span class="switch-text"
							>{p.default === true || p.default === 'true' ? 'On' : 'Off'}</span
						>
					</div>
				{:else if kind === 'select'}
					<div class="input select">
						<span>{selected(p)}</span>
						<ChevronDown size={16} aria-hidden="true" />
					</div>
				{:else if kind === 'secret'}
					<div class="input">
						<span class="dots">••••••••••••••••</span>
						<span class="gen"><Sparkles size={13} aria-hidden="true" /> generated</span>
					</div>
				{:else if text(p.default)}
					<div class="input"><span>{text(p.default)}</span></div>
				{:else}
					<div class="input"><span class="ph">{p.placeholder ?? ''}</span></div>
				{/if}
				{#if p.description}
					<p class="hint">{p.description}</p>
				{/if}
			</div>
		{/each}
	</div>
	<div class="foot">
		<span class="btn ghost">Cancel</span>
		<span class="btn primary">Deploy</span>
	</div>
</div>

<style>
	.form {
		overflow: hidden;
		border-radius: 14px;
		background: #fff;
		color: var(--color-night-800);
		box-shadow:
			0 1px 2px rgb(20 13 16 / 0.05),
			0 24px 60px -30px rgb(120 0 20 / 0.35),
			0 0 0 1px rgb(20 13 16 / 0.07);
		font-family: var(--font-sans);
	}

	.top {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		border-bottom: 1px solid rgb(20 13 16 / 0.08);
		padding: 1rem 1.25rem;
	}

	.title {
		font-size: 17px;
		font-weight: 700;
	}

	.fields {
		display: grid;
		gap: 1.1rem;
		padding: 1.25rem;
	}

	@media (min-width: 720px) {
		.fields {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.field {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.4rem;
	}

	.label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 13.5px;
		font-weight: 600;
	}

	.req {
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
		font-family: var(--font-mono);
		font-size: 10.5px;
		background: hsl(352 70% 94%);
		color: var(--color-crimson-deep);
	}

	.input {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-height: 2.6rem;
		border: 1px solid rgb(20 13 16 / 0.14);
		border-radius: 8px;
		padding: 0.55rem 0.8rem;
		font-size: 14px;
		background: #fff;
	}

	.input > span:first-child {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.ph {
		color: var(--color-night-300);
	}

	.select {
		color: var(--color-night-800);
	}

	.select :global(svg) {
		flex-shrink: 0;
		color: var(--color-night-300);
	}

	.dots {
		letter-spacing: 0.1em;
		color: var(--color-night-300);
	}

	.gen {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 0.25rem;
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		font-size: 11px;
		background: #f7f4f5;
		color: var(--color-night-700);
	}

	.hint {
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--color-night-300);
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 2.6rem;
	}

	.switch {
		position: relative;
		display: inline-block;
		width: 2.4rem;
		height: 1.4rem;
		border-radius: 999px;
		background: rgb(20 13 16 / 0.18);
	}

	.switch.on {
		background: var(--color-crimson);
	}

	.knob {
		position: absolute;
		top: 0.15rem;
		left: 0.15rem;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
	}

	.switch.on .knob {
		left: auto;
		right: 0.15rem;
	}

	.switch-text {
		font-size: 14px;
	}

	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		border-top: 1px solid rgb(20 13 16 / 0.08);
		padding: 0.85rem 1.25rem;
		background: #f7f4f5;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		border-radius: 8px;
		padding: 0.5rem 0.95rem;
		font-size: 14px;
		font-weight: 600;
	}

	.ghost {
		color: var(--color-night-700);
		box-shadow: inset 0 0 0 1px rgb(20 13 16 / 0.14);
		background: #fff;
	}

	.primary {
		background: var(--color-crimson);
		color: #fff;
	}
</style>
