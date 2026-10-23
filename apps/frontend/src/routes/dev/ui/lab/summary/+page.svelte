<script lang="ts">
	import FleetSummary from '$lib/components/patterns/FleetSummary.svelte';
	import ResourcesWidget from '$lib/components/patterns/ResourcesWidget.svelte';

	const stats = {
		running: 11,
		total: 12,
		building: 2,
		failing: 1,
		deploysToday: 14,
		deploysFailedToday: 1,
		cpu: { used: 3.24, limit: 8 },
		memory: { usedGiB: 9.38, limitGiB: 16 },
		requests24h: [
			3120, 2840, 2410, 2260, 2390, 2980, 4210, 6830, 9120, 10480, 11230, 10870, 11940, 12310,
			11780, 12620, 13490, 12880, 11350, 9870, 8420, 6910, 5230, 4080
		]
	};

	const quiet = {
		running: 7,
		total: 7,
		building: 0,
		failing: 0,
		deploysToday: 3,
		deploysFailedToday: 0,
		cpu: { used: 0.86, limit: 4 },
		memory: { usedGiB: 2.1, limitGiB: 8 }
	};

	const cpu = {
		limit: 8,
		parts: [
			{ label: 'hackclub-site', value: 1.12 },
			{ label: 'terra', value: 0.84 },
			{ label: 'slack-bots', value: 0.61 },
			{ label: 'hcb-mirror', value: 0.28 },
			{ label: 'onboard', value: 0.22 },
			{ label: 'scrapbook', value: 0.17 }
		]
	};
	const memory = {
		limit: 16,
		parts: [
			{ label: 'hackclub-site', value: 2.6 },
			{ label: 'terra', value: 3.1 },
			{ label: 'slack-bots', value: 1.45 },
			{ label: 'hcb-mirror', value: 0.92 },
			{ label: 'onboard', value: 0.71 },
			{ label: 'scrapbook', value: 0.6 }
		]
	};
</script>

<div class="lab">
	<div class="main">
		<section class="specimen">
			<h2 class="tag">Numbers</h2>
			<FleetSummary variant="numbers" {stats} />
		</section>
		<section class="specimen">
			<h2 class="tag">Numbers, all healthy</h2>
			<FleetSummary variant="numbers" stats={quiet} />
		</section>
		<section class="specimen">
			<h2 class="tag">Rings</h2>
			<FleetSummary variant="rings" {stats} />
		</section>
		<section class="specimen">
			<h2 class="tag">Sentence</h2>
			<FleetSummary variant="sentence" {stats} />
		</section>
		<section class="specimen">
			<h2 class="tag">Sentence, all healthy</h2>
			<FleetSummary variant="sentence" stats={quiet} />
		</section>
	</div>
	<aside class="side">
		<ResourcesWidget {cpu} {memory} />
	</aside>
</div>

<style>
	.lab {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		gap: 2rem;
		max-width: 76rem;
		min-height: 100vh;
		margin: 0 auto;
		padding: 3rem 2rem;
		background: var(--bg-sheet);
	}
	.main {
		display: flex;
		flex-direction: column;
		gap: 3rem;
		min-width: 0;
	}
	.specimen {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.tag {
		color: var(--text-faint);
		font-size: var(--text-micro);
		font-weight: var(--weight-medium);
		text-box: trim-both cap alphabetic;
	}
</style>
