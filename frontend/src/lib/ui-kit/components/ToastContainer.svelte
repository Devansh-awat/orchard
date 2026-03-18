<script lang="ts">
	import { toasts } from '../stores/toast';
	import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-svelte';

	const iconMap = {
		success: CheckCircle,
		error: AlertCircle,
		warning: AlertTriangle,
		info: Info
	};

	const colorMap = {
		success: 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300',
		error: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300',
		warning: 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-300',
		info: 'bg-blue-50 border-blue-200 text-blue-800 dark:bg-blue-900/20 dark:border-blue-800 dark:text-blue-300'
	};

	const iconColorMap = {
		success: 'text-green-500',
		error: 'text-red-500',
		warning: 'text-yellow-500',
		info: 'text-blue-500'
	};
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
	{#each $toasts as toast (toast.id)}
		<div
			class="flex items-start gap-3 rounded-lg border p-4 shadow-lg min-w-[300px] max-w-md {colorMap[toast.color]}"
			role="alert"
		>
			<svelte:component this={iconMap[toast.color]} class="h-5 w-5 flex-shrink-0 {iconColorMap[toast.color]}" />
			<div class="flex-1">
				<p class="font-medium">{toast.title}</p>
				{#if toast.description}
					<p class="mt-1 text-sm opacity-80">{toast.description}</p>
				{/if}
			</div>
			<button
				onclick={() => toasts.remove(toast.id)}
				class="flex-shrink-0 opacity-60 hover:opacity-100"
			>
				<X class="h-4 w-4" />
			</button>
		</div>
	{/each}
</div>
