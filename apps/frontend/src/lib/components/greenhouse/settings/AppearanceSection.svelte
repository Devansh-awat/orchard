<script lang="ts">
	import { Input, SegmentedControl, Select } from '$lib/components/ui';
	import { themeStore } from '$lib/stores/theme';
	import type { ThemeMode } from '$lib/theme/spec';
	import {
		CODE_MAX,
		CODE_MIN,
		PREF_DEFAULTS,
		ZOOM_STEPS,
		greenhousePrefs,
		type ChatSize,
		type PrefValues
	} from '../prefs.svelte';
	import Card from './Card.svelte';
	import Row from './Row.svelte';

	const MONO_FONTS = ['JetBrains Mono', 'Geist Mono', 'SF Mono', 'Fira Code', 'Menlo'] as const;
	const CUSTOM = 'custom';
	const LOOK_KEYS = [
		'zoom',
		'chatSize',
		'codeSize',
		'monoFont',
		'ligatures',
		'terminalFont'
	] as const satisfies readonly (keyof PrefValues)[];

	const themeOptions: { value: ThemeMode; label: string }[] = [
		{ value: 'auto', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];
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

	const prefs = $derived(greenhousePrefs.values);
	const preset = (name: string) => name === '' || (MONO_FONTS as readonly string[]).includes(name);

	let customMono = $state(!preset(greenhousePrefs.values.monoFont));

	const monoChoice = $derived(customMono ? CUSTOM : prefs.monoFont);
	const codeFont = $derived(greenhousePrefs.monoStack('var(--gh-mono)'));
	const termFont = $derived(greenhousePrefs.terminalStack('var(--font-mono-terminal)'));
	const features = $derived(prefs.ligatures ? "'calt' 1, 'liga' 1" : "'calt' 0, 'liga' 0");
	const lookChanged = $derived(LOOK_KEYS.some((k) => prefs[k] !== PREF_DEFAULTS[k]));

	function pickMono(value: string) {
		if (value === CUSTOM) {
			customMono = true;
			if (preset(prefs.monoFont)) greenhousePrefs.set('monoFont', '');
			return;
		}
		customMono = false;
		greenhousePrefs.set('monoFont', value);
	}

	function resetLook() {
		for (const key of LOOK_KEYS) greenhousePrefs.set(key, PREF_DEFAULTS[key]);
		customMono = false;
	}
</script>

<Card>
	<Row title="Theme" description="Shared with the rest of Orchard">
		{#snippet control()}
			<SegmentedControl
				label="Theme"
				options={themeOptions}
				value={$themeStore.mode}
				onchange={(v) => themeStore.setMode(v as ThemeMode)}
			/>
		{/snippet}
	</Row>
</Card>

<Card title="Interface">
	<Row title="Interface zoom" description="Scales all of Greenhouse">
		{#snippet control()}
			<SegmentedControl
				label="Interface zoom"
				options={zoomOptions}
				value={String(greenhousePrefs.zoom)}
				onchange={(v) => (greenhousePrefs.zoom = Number(v))}
			/>
		{/snippet}
	</Row>
	<Row title="Chat text size" description="Messages and agent replies">
		{#snippet control()}
			<SegmentedControl
				label="Chat text size"
				options={chatOptions}
				value={greenhousePrefs.chatSize}
				onchange={(v) => (greenhousePrefs.chatSize = v as ChatSize)}
			/>
		{/snippet}
	</Row>
</Card>

<Card title="Code">
	<Row title="Code font size" description="Editor, diffs and terminals">
		{#snippet control()}
			<SegmentedControl
				label="Code font size"
				options={codeOptions}
				value={String(greenhousePrefs.codeSize)}
				onchange={(v) => (greenhousePrefs.codeSize = Number(v))}
			/>
		{/snippet}
	</Row>
	<Row title="Mono font" description="Must be installed on this device">
		{#snippet control()}
			<div class="pick">
				<Select
					value={monoChoice}
					aria-label="Mono font"
					onchange={(e: Event) => pickMono((e.currentTarget as HTMLSelectElement).value)}
				>
					<option value="">Default</option>
					{#each MONO_FONTS as font (font)}
						<option value={font}>{font}</option>
					{/each}
					<option value={CUSTOM}>Custom…</option>
				</Select>
			</div>
		{/snippet}
		{#if customMono}
			<div class="field">
				<Input
					value={prefs.monoFont}
					placeholder="Font family name"
					aria-label="Custom mono font"
					autocomplete="off"
					spellcheck="false"
					maxlength={80}
					oninput={(e: Event) =>
						greenhousePrefs.set('monoFont', (e.currentTarget as HTMLInputElement).value)}
				/>
			</div>
		{/if}
		<pre
			class="sample"
			aria-hidden="true"
			style:font-family={codeFont}
			style:font-size="{prefs.codeSize}px"
			style:font-feature-settings={features}>const ready = jobs.filter((j) =&gt; j.state !== 'queued');
if (ready.length &gt;= limit) return;</pre>
	</Row>
	<Row
		title="Code ligatures"
		description="Join symbols like => and !== when the font has them"
		checked={prefs.ligatures}
		ontoggle={(v) => greenhousePrefs.set('ligatures', v)}
	/>
</Card>

<Card title="Terminal">
	<Row title="Terminal font" description="Matches the code font size">
		<div class="field">
			<Input
				value={prefs.terminalFont}
				placeholder="Leave empty to match the mono font"
				aria-label="Terminal font"
				autocomplete="off"
				spellcheck="false"
				maxlength={80}
				oninput={(e: Event) =>
					greenhousePrefs.set('terminalFont', (e.currentTarget as HTMLInputElement).value)}
			/>
		</div>
		<pre
			class="sample sample--term"
			aria-hidden="true"
			style:font-family={termFont}
			style:font-size="{prefs.codeSize}px">~/orchard $ pnpm test
 ✓ 128 passed in 4.2s · {prefs.codeSize}px</pre>
	</Row>
</Card>

{#if lookChanged}
	<button type="button" class="reset" onclick={resetLook}>Reset appearance</button>
{/if}

<style>
	.pick {
		width: 11rem;
	}

	.field {
		max-width: 22rem;
	}

	.sample {
		margin: 0;
		padding: 0.75rem 1rem;
		overflow: hidden;
		border-radius: var(--gh-r-control);
		border: 1px solid var(--gh-line-soft);
		background: var(--gh-field);
		color: var(--gh-muted-strong);
		line-height: 1.65;
		white-space: pre;
		text-overflow: ellipsis;
	}

	.sample--term {
		background: var(--console-bg);
		color: var(--console-text);
		line-height: 1.25;
	}

	.reset {
		align-self: flex-start;
		margin-top: 1rem;
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

	.reset:hover {
		color: var(--gh-text);
	}

	.reset:focus-visible {
		outline: none;
		border-radius: var(--gh-r-control);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
