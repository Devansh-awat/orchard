<script lang="ts">
	import { tick } from 'svelte';
	import { EthernetPort } from 'lucide-svelte';
	import {
		Alert,
		Button,
		Field,
		Input,
		Modal,
		ModalIntro,
		SegmentedControl
	} from '$lib/components/ui';
	import type { ServicePortForm } from '$lib/types/deployment';

	let {
		open,
		title,
		submitLabel,
		ports,
		error,
		saving,
		onUpdate,
		onSubmit,
		onCancel
	}: {
		open: boolean;
		title: string;
		submitLabel: string;
		ports: ServicePortForm[];
		error: string | null;
		saving: boolean;
		onUpdate: (index: number, changes: Partial<ServicePortForm>) => void;
		onSubmit: () => void;
		onCancel: () => void;
	} = $props();

	const uid = $props.id();

	const PROTOCOLS = [
		{ value: 'TCP', label: 'TCP' },
		{ value: 'UDP', label: 'UDP' }
	];

	const valid = $derived(
		ports.length > 0 &&
			ports.every((p) => {
				const n = Number(p.containerPort);
				return Number.isInteger(n) && n > 0 && n <= 65535;
			})
	);

	function submit() {
		if (valid && !saving) onSubmit();
	}

	function setPort(index: number, raw: string) {
		const value = Number(raw.replace(/\D/g, ''));
		onUpdate(index, { containerPort: value, servicePort: value });
	}

	function focusFirst(el: HTMLInputElement) {
		void tick().then(() => {
			el.focus();
			el.select();
		});
	}
</script>

<Modal {open} size="sm" closable={false} dismissable labelledby="{uid}-title" onclose={onCancel}>
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro
			id="{uid}-title"
			icon={EthernetPort}
			tone="neutral"
			solid
			{title}
			description="The number your app listens on. It starts private, so only your other apps can reach it."
		/>
		{#each ports as port, index (index)}
			<div class="port">
				<Field label={index === 0 ? 'Port' : undefined} for="{uid}-port-{index}">
					<Input
						id="{uid}-port-{index}"
						inputmode="numeric"
						autocomplete="off"
						size="lg"
						placeholder="3000"
						value={port.containerPort || ''}
						oninput={(e: Event) => setPort(index, (e.currentTarget as HTMLInputElement).value)}
						{@attach index === 0 ? focusFirst : undefined}
					/>
				</Field>
				<SegmentedControl
					label="Protocol"
					options={PROTOCOLS}
					value={port.protocol || 'TCP'}
					onchange={(next) => onUpdate(index, { protocol: next })}
				/>
			</div>
		{/each}
		<p class="hint">Most apps use TCP. Some games and voice apps use UDP.</p>
		{#if error}<Alert tone="error">{error}</Alert>{/if}
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={onCancel}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!valid} onclick={submit}
			>{submitLabel}</Button
		>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.hint {
		margin-top: -0.25rem;
		color: var(--text-muted);
		font-size: var(--text-footnote);
	}
	.port {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: end;
		gap: 0.75rem;
	}
</style>
