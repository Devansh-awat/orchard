<script lang="ts">
	import { Skeleton } from '$lib/components/ui';
</script>

<div class="od-grid">
	{#each Array(6) as _, i (i)}
		<div class="dash-card dash-card--skel">
			<div class="card-top">
				<Skeleton width="1.75rem" height="1.75rem" rounded="0.375rem" />
				<div class="sk-col">
					<Skeleton width="7rem" height="0.7rem" rounded="0.25rem" />
					<Skeleton width="10rem" height="0.5rem" rounded="0.25rem" />
				</div>
			</div>
			<div class="card-bot">
				<Skeleton width="4rem" height="0.5rem" rounded="0.25rem" />
				<Skeleton width="3rem" height="0.5rem" rounded="0.25rem" />
			</div>
		</div>
	{/each}
</div>
