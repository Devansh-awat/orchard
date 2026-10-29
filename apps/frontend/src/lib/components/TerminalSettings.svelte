<script lang="ts">
	import { Settings2, Minus, Plus } from 'lucide-svelte';
	import { Button, PopoverPanel, SegmentedControl, ToggleRow } from '$lib/components/ui';
	import {
		terminalDisplay,
		setTerminalDisplay,
		resetTerminalDisplay,
		isTerminalDisplayDefault,
		TERMINAL_FONT_MIN,
		TERMINAL_FONT_MAX,
		type TerminalCursor
	} from '$lib/stores/terminal-display.svelte';

	const isMac =
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
	const mod = isMac ? '⌘' : 'Ctrl';
	const pasteChord = isMac ? '⌘V' : 'Ctrl+Shift+V';

	const cursorOptions = [
		{ value: 'bar', label: 'Bar' },
		{ value: 'block', label: 'Block' },
		{ value: 'underline', label: 'Line' }
	] as const;

	function bump(delta: number) {
		setTerminalDisplay('fontSize', terminalDisplay.fontSize + delta);
	}
</script>

<PopoverPanel placement="bottom-end" class="terminal-settings">
	{#snippet trigger(attrs)}
		<Button {...attrs} variant="ghost" size="sm" icon={Settings2} label="Terminal settings" />
	{/snippet}
	{#snippet children()}
		<div class="ts-body">
			<div class="ts-row">
				<span class="ts-label">Font size</span>
				<span class="ts-stepper">
					<button
						type="button"
						class="ts-step"
						aria-label="Smaller text"
						disabled={terminalDisplay.fontSize <= TERMINAL_FONT_MIN}
						onclick={() => bump(-1)}
					>
						<Minus size={12} />
					</button>
					<span class="ts-value">{terminalDisplay.fontSize}px</span>
					<button
						type="button"
						class="ts-step"
						aria-label="Larger text"
						disabled={terminalDisplay.fontSize >= TERMINAL_FONT_MAX}
						onclick={() => bump(1)}
					>
						<Plus size={12} />
					</button>
				</span>
			</div>

			<div class="ts-row ts-row--stack">
				<span class="ts-label">Cursor</span>
				<SegmentedControl
					label="Cursor style"
					options={cursorOptions}
					value={terminalDisplay.cursorStyle}
					onchange={(v) => setTerminalDisplay('cursorStyle', v as TerminalCursor)}
					grow
				/>
			</div>

			<ToggleRow
				label="Blinking cursor"
				checked={terminalDisplay.cursorBlink}
				onchange={() => setTerminalDisplay('cursorBlink', !terminalDisplay.cursorBlink)}
			/>
			<ToggleRow
				label="Predictive echo"
				hint="Draws what you type before the pod echoes it back"
				checked={terminalDisplay.predictiveEcho}
				onchange={() => setTerminalDisplay('predictiveEcho', !terminalDisplay.predictiveEcho)}
			/>
			<ToggleRow
				label="Bell"
				hint="Marks a tab when a program rings the bell"
				checked={terminalDisplay.bell === 'visual'}
				onchange={() =>
					setTerminalDisplay('bell', terminalDisplay.bell === 'visual' ? 'off' : 'visual')}
			/>

			<div class="ts-hints">
				<span>{mod}+click opens links</span>
				<span>{pasteChord} pastes</span>
				<span>{mod}+K clears</span>
				<span>{mod} + / − zooms</span>
			</div>

			{#if !isTerminalDisplayDefault()}
				<button type="button" class="ts-reset" onclick={resetTerminalDisplay}>
					Reset to defaults
				</button>
			{/if}
		</div>
	{/snippet}
</PopoverPanel>

<style>
	:global(.ui-popover.terminal-settings) {
		width: 17rem;
	}

	.ts-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.25rem;
	}

	.ts-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.ts-row--stack {
		flex-direction: column;
		align-items: stretch;
		gap: 0.4rem;
	}

	.ts-label {
		font-size: var(--text-sm);
		color: var(--text-fg);
	}

	.ts-stepper {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.ts-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: var(--radius-xs);
		border: 1px solid var(--border-edge);
		background: var(--bg-raised);
		color: var(--text-muted);
		cursor: pointer;
	}

	.ts-step:hover:not(:disabled) {
		color: var(--text-fg);
		border-color: var(--border-strong);
	}

	.ts-step:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.ts-value {
		min-width: 2.75rem;
		text-align: center;
		font-family: var(--font-mono-terminal);
		font-size: var(--text-xs);
		color: var(--text-fg);
	}

	.ts-hints {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-edge);
		font-size: var(--text-micro);
		line-height: var(--lh-micro);
		color: var(--text-faint);
	}

	.ts-reset {
		align-self: flex-start;
		font-size: var(--text-xs);
		color: var(--text-muted);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}

	.ts-reset:hover {
		color: var(--text-fg);
		text-decoration: underline;
	}
</style>
