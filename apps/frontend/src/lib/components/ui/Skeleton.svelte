<script lang="ts">
	let {
		width = '100%',
		height = '1rem',
		rounded = '0.5rem',
		class: className = ''
	}: {
		width?: string;
		height?: string;
		rounded?: string;
		class?: string;
	} = $props();
</script>

<div
	class="ui-skeleton{className ? ` ${className}` : ''}"
	style="width: {width}; height: {height}; border-radius: {rounded};"
></div>
