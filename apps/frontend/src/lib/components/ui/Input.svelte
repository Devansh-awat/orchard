<script lang="ts">
	let {
		value = $bindable(''),
		error = false,
		class: className = '',
		...rest
	}: {
		value?: string;
		error?: boolean;
		class?: string;
		[key: string]: unknown;
	} = $props();
</script>

<input
	class="input{error ? ' input-error' : ''}{className ? ` ${className}` : ''}"
	bind:value
	{...rest}
/>
