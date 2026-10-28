<script lang="ts">
	import { Crown, FolderInput, Trash2 } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import ActionRow from '$lib/components/ui/ActionRow.svelte';
	import ImageField from '$lib/components/ui/ImageField.svelte';
	import AppIcon from '$lib/components/ui/AppIcon.svelte';
	import Field from '$lib/components/ui/Field.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Stack from '$lib/components/ui/Stack.svelte';

	let icon = $state<string | null>(null);
	let background = $state<string | null>(null);
	let transferPending = $state(false);

	function readAsUrl(file: File): Promise<string | null> {
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () =>
				setTimeout(() => resolve(typeof reader.result === 'string' ? reader.result : null), 900);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(file);
		});
	}
</script>

<div class="grid grid-cols-2 gap-6">
	<SectionCard title="Danger zone">
		<Stack>
			<ActionRow
				label="Transfer ownership"
				hint={transferPending
					? 'A transfer is waiting on the new owner to accept.'
					: "Everything here counts against the new owner's allowance."}
			>
				<Button
					size="sm"
					icon={Crown}
					disabled={transferPending}
					onclick={() => (transferPending = true)}
				>
					Transfer
				</Button>
			</ActionRow>
			<ActionRow
				label="Move to another organization"
				hint="Members who are not in the other organization lose access."
			>
				<Button size="sm" icon={FolderInput}>Move</Button>
			</ActionRow>
			<ActionRow
				label="Delete project"
				hint="Deletes every environment, app, database, backup, domain and job in it. There is no undo."
			>
				<Button variant="danger" size="sm" icon={Trash2}>Delete</Button>
			</ActionRow>
		</Stack>
	</SectionCard>

	<SectionCard title="Image uploads">
		<Stack gap="lg">
			<Field label="Icon" hint="PNG, JPG or SVG, up to 2 MB" for="demo-icon">
				<ImageField id="demo-icon" bind:value={icon} upload={readAsUrl} accept="image/*">
					{#snippet fallback()}<AppIcon name="hackclub-site" kind="project" size="lg" />{/snippet}
				</ImageField>
			</Field>
			<Field label="Background" hint="PNG, JPG or WebP, up to 8 MB" for="demo-bg">
				<ImageField
					id="demo-bg"
					shape="wide"
					bind:value={background}
					upload={readAsUrl}
					accept="image/*"
				/>
			</Field>
		</Stack>
	</SectionCard>
</div>
