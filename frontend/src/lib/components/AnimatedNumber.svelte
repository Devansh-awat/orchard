<script lang="ts">
	import { Tween } from 'svelte/motion';
	import { cubicOut } from 'svelte/easing';

	interface Props {
		value: number;
		duration?: number;
		format?: (n: number) => string;
		class?: string;
	}

	let {
		value,
		duration = 400,
		format = (n: number) => String(Math.round(n)),
		class: klass = '',
	}: Props = $props();

	// Start at 0 so first paint animates up to `value` (matches the
	// motion.dev count-up example).
	const tween = new Tween(0, { duration, easing: cubicOut });
	$effect(() => {
		tween.set(value);
	});
</script>

<span class={klass}>{format(tween.current)}</span>
