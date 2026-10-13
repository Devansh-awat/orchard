<script lang="ts">
	import type { Snippet } from 'svelte';
	import TabStrip from './TabStrip.svelte';
	import type { StripTab } from './types';
	import type { EditorDocument, EditorWorkspace } from './workspace.svelte';

	let {
		workspace,
		onclose = undefined,
		leading = undefined,
		trailing = undefined
	}: {
		workspace: EditorWorkspace;
		onclose?: (doc: EditorDocument) => void;
		leading?: Snippet;
		trailing?: Snippet;
	} = $props();

	const tabs = $derived<StripTab[]>(
		workspace.documents.map((doc) => ({
			id: doc.uri,
			title: doc.name,
			tooltip: doc.path,
			dirty: doc.dirty
		}))
	);

	function close(id: string) {
		const doc = workspace.documents.find((d) => d.uri === id);
		if (!doc) return;
		if (onclose) onclose(doc);
		else workspace.close(doc.path);
	}

	function reorder(from: number, to: number) {
		workspace.move(from, to);
	}
</script>

<TabStrip
	{tabs}
	active={workspace.activeUri}
	label="Open files"
	onselect={(id) => workspace.activate(id)}
	onclose={close}
	onreorder={reorder}
	{leading}
	{trailing}
/>
