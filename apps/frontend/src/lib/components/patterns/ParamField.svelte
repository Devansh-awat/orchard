<script lang="ts" module>
	export type ParamDef = {
		name: string;
		displayName: string;
		description?: string;
		type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
		default?: unknown;
		required?: boolean;
		placeholder?: string;
		validation?: {
			pattern?: string;
			message?: string;
			min?: number;
			max?: number;
			bytes?: number;
		};
		options?: { label: string; value: string }[];
	};

	export function paramProblem(param: ParamDef, value: unknown): string | null {
		const empty = value === undefined || value === null || value === '';
		if (empty) return param.required ? `${param.displayName} is required` : null;
		if (param.type === 'number') {
			const n = Number(value);
			if (Number.isNaN(n)) return 'Enter a number';
			if (param.validation?.min !== undefined && n < param.validation.min)
				return `At least ${param.validation.min}`;
			if (param.validation?.max !== undefined && n > param.validation.max)
				return `At most ${param.validation.max}`;
		}
		if (param.type === 'string' && param.validation?.pattern) {
			if (!new RegExp(param.validation.pattern).test(String(value)))
				return param.validation.message ?? 'This value is not valid';
		}
		return null;
	}

	const SEGMENTED_MAX = 4;

	function unitOf(param: ParamDef) {
		if (/gi$/i.test(param.name)) return 'GiB';
		if (/mi$/i.test(param.name)) return 'MiB';
		if (/interval|seconds/i.test(param.name)) return 'sec';
		return undefined;
	}
</script>

<script lang="ts">
	import Field from '$lib/components/ui/Field.svelte';
	import Input from '$lib/components/ui/Input.svelte';
	import SecretInput from '$lib/components/ui/SecretInput.svelte';
	import Dropdown from '$lib/components/ui/Dropdown.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import ToggleRow from '$lib/components/ui/ToggleRow.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		param,
		value = $bindable(),
		error = null,
		disabled = false,
		suggestion = null,
		onblur = undefined
	}: {
		param: ParamDef;
		value?: any;
		error?: string | null;
		disabled?: boolean;
		suggestion?: string | null;
		onblur?: () => void;
	} = $props();

	const id = $derived(`param-${param.name}`);
	const options = $derived((param.options ?? []).map((o) => ({ value: o.value, label: o.label })));
</script>

{#if param.type === 'boolean'}
	<ToggleRow
		label={param.displayName}
		hint={param.description ?? null}
		bind:checked={value}
		{disabled}
	/>
{:else if param.type === 'select'}
	<Field label={param.displayName} hint={param.description} for={id} required={param.required}>
		{#if options.length <= SEGMENTED_MAX}
			<SegmentedControl label={param.displayName} size="sm" {options} bind:value />
		{:else}
			<Dropdown {id} {options} {disabled} bind:value />
		{/if}
	</Field>
{:else if param.type === 'secret'}
	<Field label={param.displayName} {error} for={id} required={param.required}>
		<SecretInput
			{id}
			{disabled}
			placeholder={param.placeholder || 'Generated on deploy'}
			bind:value
		/>
	</Field>
{:else if param.type === 'number'}
	<Field
		label={param.displayName}
		hint={param.description}
		{error}
		for={id}
		required={param.required}
	>
		<Input
			{id}
			type="number"
			width="short"
			min={param.validation?.min}
			max={param.validation?.max}
			suffix={unitOf(param)}
			error={!!error}
			{disabled}
			{onblur}
			bind:value
		/>
	</Field>
{:else}
	<Field label={param.displayName} {error} for={id} required={param.required}>
		<Input
			{id}
			placeholder={param.placeholder || ''}
			error={!!error}
			{disabled}
			{onblur}
			bind:value
		/>
		{#snippet hint()}
			{param.description ?? ''}
			{#if suggestion && value !== suggestion}
				<span class="suggest">
					<Button size="sm" variant="tinted" onclick={() => (value = suggestion)}>
						Use {suggestion}
					</Button>
				</span>
			{/if}
		{/snippet}
	</Field>
{/if}

<style>
	.suggest {
		display: block;
		margin-top: var(--space-2);
	}
</style>
