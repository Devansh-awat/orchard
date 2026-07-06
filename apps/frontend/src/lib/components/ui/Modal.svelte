<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';

	let {
		open = $bindable(false),
		title = undefined,
		size = 'md',
		closable = true,
		onclose = undefined,
		children,
		footer = undefined
	}: {
		open?: boolean;
		title?: string;
		size?: 'sm' | 'md' | 'lg' | 'xl';
		closable?: boolean;
		onclose?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) dialogEl.showModal();
		else if (!open && dialogEl.open) dialogEl.close();
	});

	function handleClose() {
		open = false;
		onclose?.();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (closable && e.target === dialogEl) handleClose();
	}

	function handleCancel(e: Event) {
		if (!closable) {
			e.preventDefault();
			return;
		}
		handleClose();
	}
</script>

<dialog
	bind:this={dialogEl}
	class="ui-modal ui-modal--{size}"
	onclick={handleBackdropClick}
	oncancel={handleCancel}
	onclose={() => {
		if (open) handleClose();
	}}
>
	{#if title || closable}
		<div class="ui-modal-header">
			{#if title}<h2 class="ui-modal-title">{title}</h2>{/if}
			{#if closable}
				<button type="button" class="ui-modal-close" aria-label="Close" onclick={handleClose}>
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
