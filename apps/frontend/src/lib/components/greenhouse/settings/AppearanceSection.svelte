<script lang="ts">
	import { SegmentedControl } from '$lib/components/ui';
	import { CODE_MAX, CODE_MIN, ZOOM_STEPS, greenhousePrefs, type ChatSize } from '../prefs.svelte';
	import Block from './Block.svelte';

	const zoomOptions = ZOOM_STEPS.map((z) => ({
		value: String(z),
		label: `${Math.round(z * 100)}%`
	}));
	const chatOptions: { value: ChatSize; label: string }[] = [
		{ value: 'sm', label: 'Small' },
		{ value: 'md', label: 'Default' },
		{ value: 'lg', label: 'Large' }
	];
	const codeOptions = Array.from({ length: CODE_MAX - CODE_MIN + 1 }, (_, i) => {
		const size = String(CODE_MIN + i);
		return { value: size, label: size };
	});
</script>

<Block>
	<div class="field">
		<span class="label">Interface zoom</span>
		<SegmentedControl
			label="Interface zoom"
			options={zoomOptions}
			value={String(greenhousePrefs.zoom)}
			onchange={(v) => (greenhousePrefs.zoom = Number(v))}
		/>
	</div>
</Block>

<Block columns={2}>
	<div class="field">
		<span class="label">Chat text</span>
		<SegmentedControl
			label="Chat text"
			options={chatOptions}
			value={greenhousePrefs.chatSize}
			onchange={(v) => (greenhousePrefs.chatSize = v as ChatSize)}
		/>
	</div>
	<div class="field">
		<span class="label">Code size</span>
		<SegmentedControl
			label="Code font size"
			options={codeOptions}
			value={String(greenhousePrefs.codeSize)}
			onchange={(v) => (greenhousePrefs.codeSize = Number(v))}
		/>
	</div>
</Block>

<Block>
	<div class="preview" style={greenhousePrefs.style} aria-hidden="true">
		<p class="prose">Fixed the flaky socket test, it now waits for the close frame.</p>
		<pre class="code gh-mono">await socket.closed;</pre>
	</div>
	{#if !greenhousePrefs.isDefault}
		<button type="button" class="link" onclick={() => greenhousePrefs.reset()}>Reset</button>
	{/if}
</Block>

<style>
	.field {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
		min-width: 0;
	}

	.label {
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		font-weight: 600;
		color: var(--gh-text);
	}

	.preview {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border-radius: var(--gh-r-row);
		border: 1px solid var(--gh-line-soft);
		background: var(--gh-field);
	}

	.prose {
		margin: 0;
		max-width: 65ch;
		font-size: var(--gh-reading);
		line-height: var(--gh-lh-reading);
		color: var(--gh-text);
	}

	.code {
		margin: 0;
		font-family: var(--gh-mono);
		font-size: var(--gh-code-size);
		line-height: 1.65;
		color: var(--gh-muted-strong);
		white-space: pre;
		overflow: hidden;
	}

	.link {
		justify-self: start;
		padding: 0;
		border: none;
		background: none;
		color: var(--gh-muted);
		font-size: var(--gh-ui);
		line-height: var(--gh-lh-ui);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	.link:hover {
		color: var(--gh-text);
	}

	.link:focus-visible {
		outline: none;
		border-radius: var(--gh-r-control);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
