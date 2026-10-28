<script lang="ts">
	import { Settings } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';
	import PageTabs from '$lib/components/ui/PageTabs.svelte';

	let tab = $state<'overview' | 'logs' | 'metrics' | 'settings'>('overview');
	let section = $state<'overview' | 'variables' | 'compose' | 'members' | 'settings'>('overview');
</script>

<SectionCard title="Tabs">
	<Tabs
		bind:value={tab}
		tabs={[
			{ id: 'overview', label: 'Overview' },
			{ id: 'logs', label: 'Logs' },
			{ id: 'metrics', label: 'Metrics' },
			{ id: 'settings', label: 'Settings', count: 2 }
		]}
	/>
</SectionCard>

<SectionCard
	title="Page tabs"
	description="Sections of a page: a glass capsule whose raised segment slides to the pick."
>
	<PageTabs
		label="Project sections"
		bind:value={section}
		tabs={[
			{ id: 'overview', label: 'Overview', count: 4 },
			{ id: 'variables', label: 'Variables' },
			{ id: 'compose', label: 'Compose', count: 3 },
			{ id: 'members', label: 'Members', count: 3 },
			{ id: 'settings', label: 'Settings' }
		]}
	/>
</SectionCard>
