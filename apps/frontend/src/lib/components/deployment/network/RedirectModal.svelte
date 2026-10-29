<script lang="ts">
	import { CornerUpRight } from 'lucide-svelte';
	import { Button, Dropdown, Field, Input, Modal, ModalIntro } from '$lib/components/ui';
	import { REDIRECT_STATUS_OPTIONS, redirectLabel } from './network';

	let {
		open = $bindable(false),
		ingress,
		saving,
		onSave
	}: {
		open: boolean;
		ingress: any | null;
		saving: boolean;
		onSave: (data: { host: string; redirectTarget: string; redirectStatus: number }) => void;
	} = $props();

	const uid = $props.id();

	let host = $state('');
	let target = $state('');
	let status = $state('307');
	let loadedFor: string | null = null;

	$effect.pre(() => {
		const current = open ? ingress : null;
		if (!current) {
			loadedFor = null;
			return;
		}
		if (loadedFor === current.id) return;
		loadedFor = current.id;
		host = current.host;
		target = redirectLabel(current);
		status = String(current.redirectStatus ?? 307);
	});

	const nextHost = $derived(host.trim().toLowerCase());
	const moved = $derived(!!ingress && nextHost !== ingress.host);
	const dirty = $derived(
		!!ingress &&
			(moved ||
				target.trim() !== redirectLabel(ingress) ||
				status !== String(ingress.redirectStatus ?? 307))
	);
	const ready = $derived(!!nextHost && !!target.trim() && dirty);

	function submit() {
		if (!ready || saving) return;
		onSave({ host: nextHost, redirectTarget: target.trim(), redirectStatus: Number(status) });
	}
</script>

<Modal bind:open size="sm" closable={false} dismissable labelledby="{uid}-title">
	<form
		class="form"
		onsubmit={(e) => {
			e.preventDefault();
			submit();
		}}
	>
		<ModalIntro id="{uid}-title" icon={CornerUpRight} title="Edit redirect" />
		<Field label="Domain" for="{uid}-host" hint="A new domain needs its DNS pointed here first.">
			<Input id="{uid}-host" mono autocomplete="off" spellcheck={false} bind:value={host} />
		</Field>
		<Field label="Redirect to" for="{uid}-target" hint="Keeps the path and query.">
			<Input
				id="{uid}-target"
				placeholder="example.com"
				mono
				autocomplete="off"
				spellcheck={false}
				bind:value={target}
			/>
		</Field>
		<Field label="Status">
			<Dropdown bind:value={status} options={REDIRECT_STATUS_OPTIONS} ariaLabel="Redirect status" />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="ghost" disabled={saving} onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" loading={saving} disabled={!ready} onclick={submit}>Save</Button>
	{/snippet}
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
