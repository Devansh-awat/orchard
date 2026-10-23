<script lang="ts">
	import { Plus, Rocket, Settings, Trash2, ExternalLink, Ellipsis } from 'lucide-svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';

	let loading = $state(false);
</script>

<SectionCard
	title="Buttons"
	description="One primary per view. Danger never takes the primary role."
>
	<div class="flex flex-col gap-4">
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="primary" icon={Rocket}>Deploy</Button>
			<Button>Cancel</Button>
			<Button variant="ghost">Learn more</Button>
			<Button variant="danger" icon={Trash2}>Delete app</Button>
			<Button variant="primary" loading>Deploying</Button>
			<Button disabled>Disabled</Button>
			<Button icon={Settings} label="Settings" />
			<Button variant="ghost" icon={Ellipsis} label="More" />
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button size="lg" variant="primary" icon={Rocket}>Deploy now</Button>
			<Button size="lg">Not now</Button>
			<Button size="lg" variant="tinted" icon={Plus}>Add domain</Button>
			<Button size="lg" icon={Settings} label="Settings" />
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="tinted" icon={Plus}>New database</Button>
			<Button variant="tinted" size="sm">Tinted small</Button>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button size="sm" variant="primary" icon={Plus}>New</Button>
			<Button size="sm" iconRight={ExternalLink}>Visit</Button>
			<Button size="sm" variant="ghost">Ghost</Button>
			<Button size="sm" variant="danger">Remove</Button>
			<Button size="sm" icon={Settings} label="Settings" />
			<Button
				size="sm"
				variant="primary"
				{loading}
				onclick={() => {
					loading = true;
					setTimeout(() => (loading = false), 1500);
				}}>Save changes</Button
			>
		</div>
	</div>
</SectionCard>
