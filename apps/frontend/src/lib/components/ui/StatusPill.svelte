<script lang="ts">
	let {
		active = false,
		tone = undefined,
		label
	}: {
		active?: boolean;
		tone?: 'online' | 'warn' | 'error' | 'muted';
		label: string;
	} = $props();

	const resolved = $derived(tone ?? (active ? 'online' : 'muted'));
</script>

<div class="ui-status-pill ui-status-pill--{resolved}">
	<span class="ui-status-dot"></span>
	{label}
</div>
