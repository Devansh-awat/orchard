<script lang="ts">
	import type { HostApi } from '@orchard/graft-sdk/client';
	import { Alert } from '@orchard/graft-ui';
	import { listAnnouncements, type Announcement } from './api';

	let { host }: { host: HostApi } = $props();
	let items = $state<Announcement[]>([]);

	$effect(() => {
		listAnnouncements(host)
			.then((list) => (items = list))
			.catch(() => (items = []));
	});
</script>

{#if items.length}
	<div class="announcements">
		{#each items.slice(0, 3) as item (item.id)}
			<Alert tone={item.tone} title={item.author ? `From ${item.author}` : 'Announcement'}>
				{item.body}
			</Alert>
		{/each}
	</div>
{/if}

<style>
	.announcements {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
</style>
