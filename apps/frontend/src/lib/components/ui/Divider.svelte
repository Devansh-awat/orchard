<script lang="ts">
	let { label = undefined }: { label?: string } = $props();
</script>

{#if label}
	<div class="divider divider--label" role="separator" aria-label={label}>
		<span aria-hidden="true">{label}</span>
	</div>
{:else}
	<hr class="divider" />
{/if}

<style>
	.divider {
		width: 100%;
		height: 0.5px;
		margin: 0;
		border: 0;
		background: var(--rule-strong);
	}
	.divider--label {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: auto;
		background: none;
		font-size: var(--text-caption);
		line-height: var(--lh-caption);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.divider--label::before,
	.divider--label::after {
		content: '';
		flex: 1;
		height: 0.5px;
		background: var(--rule-strong);
	}
</style>
