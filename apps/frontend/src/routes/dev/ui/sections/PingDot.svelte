<script lang="ts">
	let { size = 8 }: { size?: number } = $props();
</script>

<span class="ping" style:--dot-size="{size}px" aria-hidden="true">
	<span class="ping-halo"></span>
</span>

<style>
	.ping {
		position: relative;
		display: inline-block;
		flex-shrink: 0;
		width: var(--dot-size);
		height: var(--dot-size);
		border-radius: 50%;
		background: var(--status-progress-solid);
	}
	.ping-halo {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: var(--status-progress-solid);
		animation: radar 1.2s ease-out infinite;
	}
	@keyframes radar {
		to {
			transform: scale(2.6);
			opacity: 0;
		}
	}
</style>
