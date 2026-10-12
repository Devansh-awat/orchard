<script lang="ts">
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { graftConfirms } from './confirm.svelte';

	const current = $derived(graftConfirms.current);
</script>

{#if current}
	<ConfirmModal
		open={true}
		title={current.title}
		description={current.body ?? ''}
		confirmLabel={current.confirmLabel ?? 'Confirm'}
		danger={current.danger ?? false}
		onconfirm={() => graftConfirms.answer(true)}
		oncancel={() => graftConfirms.answer(false)}
	/>
{/if}
