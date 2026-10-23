<script lang="ts">
	import { Settings } from 'lucide-svelte';
	import SectionCard from '$lib/components/ui/SectionCard.svelte';
	import Tabs from '$lib/components/ui/Tabs.svelte';

	let tab = $state<'overview' | 'logs' | 'metrics' | 'settings'>('overview');
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
