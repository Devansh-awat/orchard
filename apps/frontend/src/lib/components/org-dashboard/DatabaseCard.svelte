<script lang="ts">
	import { springHover, cardTilt } from '$lib/utils/motion.svelte';
	import { IMG_ICONS, timeAgo } from './helpers.svelte';
	import type { DatabaseSummary } from './types';

	let {
		db,
		orgSlug
	}: {
		db: DatabaseSummary;
		orgSlug: string;
	} = $props();

	const dbIcon = IMG_ICONS.postgres;
</script>

<a
	href="/{orgSlug}/databases/{db.id}"
	class="dash-card"
	{@attach springHover({ lift: -3, stiffness: 360, damping: 22 })}
	{@attach cardTilt({ max: 4 })}
>
	<div class="card-top">
		<img src={dbIcon} alt="" class="card-ic" />
		<div class="card-text">
			<span class="card-name">{db.name}</span>
			<span class="card-sub">{db.dbName}</span>
		</div>
	</div>
	<div class="card-bot">
		<span class="card-status">
			<span
				class="dot {db.status === 'ready'
					? 'dot--green'
					: db.status === 'error'
						? 'dot--red'
						: 'dot--amber'}"
			></span>
			{db.status === 'ready' ? 'Running' : db.status.charAt(0).toUpperCase() + db.status.slice(1)}
		</span>
		<span class="card-meta">{timeAgo(db.updatedAt)}</span>
	</div>
</a>
