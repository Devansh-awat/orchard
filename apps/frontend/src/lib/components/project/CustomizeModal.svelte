<script lang="ts">
	import { Button, Field, ImageField, Input, Modal, Stack } from '$lib/components/ui';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import type { Project } from './types';

	let {
		project,
		open = $bindable(false),
		onSave,
		onIconUpload,
		onBgUpload
	}: {
		project: Project;
		open?: boolean;
		onSave: (payload: {
			icon?: string | null;
			backgroundImage?: string | null;
			name?: string;
		}) => Promise<void>;
		onIconUpload: (file: File) => Promise<string | null>;
		onBgUpload: (file: File) => Promise<string | null>;
	} = $props();

	const uid = $props.id();

	let saving = $state(false);
	let uploadingIcon = $state(false);
	let uploadingBg = $state(false);
	let iconValue = $state<string | null>(null);
	let bgValue = $state<string | null>(null);
	let nameValue = $state('');
	let wasOpen = false;

	$effect(() => {
		if (open && !wasOpen) {
			wasOpen = true;
			iconValue = project?.icon ?? null;
			bgValue = project?.backgroundImage ?? null;
			nameValue = project?.name ?? '';
		} else if (!open) {
			wasOpen = false;
		}
	});

	async function save() {
		if (saving || uploadingIcon || uploadingBg) return;
		saving = true;
		try {
			const payload: { icon?: string | null; backgroundImage?: string | null; name?: string } = {};
			if (iconValue !== (project.icon ?? null)) payload.icon = iconValue;
			if (bgValue !== (project.backgroundImage ?? null)) payload.backgroundImage = bgValue;
			const trimmedName = nameValue.trim();
			if (trimmedName && trimmedName !== project.name) payload.name = trimmedName;
			await onSave(payload);
			open = false;
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title="Customize project">
	<form
		id={uid}
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<Stack gap="lg">
			<Field label="Name" for="{uid}-name">
				<Input
					id="{uid}-name"
					size="lg"
					placeholder={project.name}
					maxlength={255}
					bind:value={nameValue}
				/>
			</Field>

			<Field label="Icon" for="{uid}-icon">
				<ImageField
					id="{uid}-icon"
					bind:value={iconValue}
					bind:busy={uploadingIcon}
					upload={onIconUpload}
					accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
				>
					{#snippet fallback()}
						<AppIcon name={nameValue.trim() || project.name} kind="project" size="lg" />
					{/snippet}
				</ImageField>
			</Field>

			<Field label="Background" for="{uid}-bg">
				<ImageField
					id="{uid}-bg"
					shape="wide"
					bind:value={bgValue}
					bind:busy={uploadingBg}
					upload={onBgUpload}
					accept="image/png,image/jpeg,image/webp"
				/>
			</Field>
		</Stack>
	</form>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)} disabled={saving}>Cancel</Button>
		<Button
			type="submit"
			form={uid}
			variant="primary"
			loading={saving}
			disabled={uploadingIcon || uploadingBg}
		>
			Save
		</Button>
	{/snippet}
</Modal>
