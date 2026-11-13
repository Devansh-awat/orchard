<script lang="ts">
	import { Check } from 'lucide-svelte';
	import { PLATFORMS, type Row } from '$lib/compare';

	let { rows, caption }: { rows: Row[]; caption: string } = $props();
</script>

<div class="box">
	<div class="scroll">
		<table>
			<caption class="sr-only">{caption}</caption>
			<thead>
				<tr>
					<th scope="col" class="feature"><span class="sr-only">Feature</span></th>
					{#each PLATFORMS as platform, i (platform)}
						<th scope="col" class:ours={i === 0}>{platform}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.feature)}
					<tr>
						<th scope="row" class="feature">{row.feature}</th>
						{#each row.cells as cell, i (i)}
							<td class:ours={i === 0}>
								{#if !cell.text}
									<span class="none" aria-hidden="true">—</span><span class="sr-only"
										>Not documented</span
									>
								{:else}
									<svelte:element
										this={cell.href ? 'a' : 'span'}
										href={cell.href}
										class={cell.href ? 'src' : undefined}
									>
										{#if cell.text === 'Yes'}
											<Check size={18} strokeWidth={2.5} aria-hidden="true" /><span class="sr-only"
												>Yes</span
											>
										{:else}
											{cell.text}
										{/if}
									</svelte:element>
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.box {
		border-radius: 20px;
		background: #fff;
		box-shadow:
			0 1px 0 rgb(195 16 38 / 0.08),
			0 20px 50px -30px rgb(195 16 38 / 0.35);
		overflow: hidden;
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 900px;
		border-collapse: separate;
		border-spacing: 0;
		font-size: 0.9rem;
		line-height: 1.4;
		color: var(--color-crimson-deep);
		table-layout: fixed;
	}

	th,
	td {
		padding: 0.85rem 1rem;
		text-align: left;
		vertical-align: top;
		border-bottom: 1px solid rgb(195 16 38 / 0.1);
		background: #fff;
	}

	tbody tr:last-child > * {
		border-bottom: 0;
	}

	thead th {
		font-size: 0.8rem;
		font-weight: 700;
		color: rgb(195 16 38 / 0.75);
		background: rgb(255 248 249);
	}

	.feature {
		position: sticky;
		left: 0;
		z-index: 1;
		width: 220px;
		font-weight: 600;
		box-shadow: inset -1px 0 0 rgb(195 16 38 / 0.1);
	}

	.ours {
		background: rgb(255 238 241);
		color: var(--color-crimson-deep);
		font-weight: 600;
	}

	thead th.ours {
		color: var(--color-crimson-deep);
		background: rgb(255 223 227);
	}

	.none {
		color: rgb(195 16 38 / 0.35);
	}

	.src {
		display: inline-flex;
		text-decoration: underline;
		text-decoration-color: rgb(195 16 38 / 0.2);
		text-underline-offset: 3px;
	}

	.src:hover {
		text-decoration-color: currentColor;
	}

	@media (max-width: 639px) {
		table {
			min-width: 760px;
			font-size: 0.8125rem;
		}

		th,
		td {
			padding: 0.7rem 0.75rem;
		}

		.feature {
			width: 120px;
		}
	}

	.src:focus-visible {
		outline: 2px solid var(--color-crimson-deep);
		outline-offset: 2px;
		border-radius: 2px;
	}
</style>
