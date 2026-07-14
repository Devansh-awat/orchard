<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';
	import { motionPopover } from '$lib/utils/motion.svelte';

	let {
		open = $bindable(false),
		title = undefined,
		size = 'md',
		closable = true,
		onclose = undefined,
		header = undefined,
		children,
		footer = undefined
	}: {
		open?: boolean;
		title?: string;
		size?: 'sm' | 'md' | 'lg' | 'xl';
		closable?: boolean;
		onclose?: () => void;
		header?: Snippet;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);
	let rendered = $state(false);

	$effect(() => {
		if (open) rendered = true;
	});

	$effect(() => {
		if (dialogEl && !dialogEl.open) dialogEl.showModal();
	});

	function requestClose() {
		open = false;
		onclose?.();
	}

	function finishClose() {
		dialogEl?.close();
		rendered = false;
	}

	function handleBackdropClick(e: MouseEvent) {
		if (closable && e.target === dialogEl) requestClose();
	}

	function handleCancel(e: Event) {
		e.preventDefault();
		if (closable) requestClose();
	}
</script>

{#if rendered}
	<dialog
		bind:this={dialogEl}
		class="ui-modal ui-modal--{size}"
		class:ui-modal--closing={!open}
		onclick={handleBackdropClick}
		oncancel={handleCancel}
		onclose={() => {
			if (open) requestClose();
			rendered = false;
		}}
		{@attach motionPopover({
			closing: () => !open,
			onClosed: finishClose,
			from: { opacity: 0, scale: 0.96, y: 8 }
		})}
	>
		{#if header || title || closable}
			<div class="ui-modal-header">
				{#if header}
					{@render header()}
				{:else if title}
					<h2 class="ui-modal-title">{title}</h2>
				{/if}
				{#if closable}
					<button type="button" class="ui-modal-close" aria-label="Close" onclick={requestClose}>
						<X size={16} />
					</button>
				{/if}
			</div>
		{/if}
		<div class="ui-modal-body">
			{@render children()}
		</div>
		{#if footer}
			<div class="ui-modal-footer">
				{@render footer()}
			</div>
		{/if}
	</dialog>
{/if}
