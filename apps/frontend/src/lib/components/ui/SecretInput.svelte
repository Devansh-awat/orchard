<script lang="ts">
	import { Eye, EyeOff } from 'lucide-svelte';
	import Input from './Input.svelte';
	import Button from './Button.svelte';

	let {
		value = $bindable(''),
		placeholder = '',
		size = 'md',
		...rest
	}: {
		value?: string | number | null;
		placeholder?: string;
		size?: 'lg' | 'md' | 'sm';
		[key: string]: unknown;
	} = $props();

	let shown = $state(false);
</script>

<Input
	{...rest}
	{size}
	{placeholder}
	type={shown ? 'text' : 'password'}
	autocomplete="off"
	spellcheck="false"
	mono={shown && !!value}
	bind:value
>
	{#snippet suffix()}
		<Button
			size="sm"
			variant="ghost"
			icon={shown ? EyeOff : Eye}
			label={shown ? 'Hide' : 'Show'}
			onclick={() => (shown = !shown)}
		/>
	{/snippet}
</Input>
