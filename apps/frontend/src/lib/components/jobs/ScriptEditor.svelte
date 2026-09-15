<script lang="ts">
	import { Field, Dropdown } from '$lib/components/ui';
	import type { ScriptRuntime } from '$lib/types/jobs';

	let {
		script = $bindable(''),
		runtime = $bindable('bash' as ScriptRuntime),
		idPrefix = 'step'
	}: {
		script?: string;
		runtime?: ScriptRuntime;
		idPrefix?: string;
	} = $props();

	const RUNTIME_INFO: Record<ScriptRuntime, { label: string; image: string; placeholder: string }> =
		{
			bash: {
				label: 'Bash',
				image: 'debian:12-slim',
				placeholder: '#!/bin/bash\nset -euo pipefail\n\necho "hello from orchard"'
			},
			python: {
				label: 'Python 3.12',
				image: 'python:3.12-slim',
				placeholder: 'import os\n\nprint("hello from orchard")'
			},
			node: {
				label: 'Node 22',
				image: 'node:22-slim',
				placeholder: 'console.log("hello from orchard");'
			}
		};

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		e.preventDefault();
		const el = e.currentTarget as HTMLTextAreaElement;
		const start = el.selectionStart;
		const end = el.selectionEnd;
		script = `${script.slice(0, start)}  ${script.slice(end)}`;
		requestAnimationFrame(() => {
			el.selectionStart = start + 2;
			el.selectionEnd = start + 2;
		});
	}
</script>

<div class="job-script-editor">
	<div class="job-script-toolbar">
		<Field label="Language" for="{idPrefix}-runtime">
			<Dropdown
				id="{idPrefix}-runtime"
				bind:value={runtime}
				options={Object.entries(RUNTIME_INFO).map(([value, info]) => ({
					value,
					label: info.label,
					description: info.image
				}))}
			/>
		</Field>
		<code class="job-inline-code job-script-runtime-chip">{RUNTIME_INFO[runtime].image}</code>
	</div>
	<textarea
		class="job-script-textarea"
		spellcheck="false"
		autocomplete="off"
		autocapitalize="off"
		placeholder={RUNTIME_INFO[runtime].placeholder}
		bind:value={script}
		onkeydown={onKeydown}></textarea>
</div>
