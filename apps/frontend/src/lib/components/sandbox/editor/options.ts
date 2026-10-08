import type * as Monaco from 'monaco-editor';
import type { EffectiveAnimationLevel } from '$lib/stores/preferences';
import type { TerminalCursor } from '$lib/stores/terminal-display.svelte';
import { monoFontFor } from '$lib/terminal/font';
import { MONACO_THEME } from './theme';

export interface LookOptions {
	fontSize: number;
	motion: EffectiveAnimationLevel;
	cursorStyle?: TerminalCursor;
	cursorBlink?: boolean;
}

const CURSOR: Record<TerminalCursor, 'line' | 'block' | 'underline'> = {
	bar: 'line',
	block: 'block',
	underline: 'underline'
};

export function lookOptions(look: LookOptions): Monaco.editor.IEditorOptions {
	const full = look.motion === 'full';
	const blink = look.cursorBlink !== false && look.motion !== 'off';
	return {
		fontSize: look.fontSize,
		lineHeight: Math.round(look.fontSize * 1.65),
		cursorSmoothCaretAnimation: full ? 'on' : 'off',
		smoothScrolling: full,
		cursorBlinking: blink ? (full ? 'smooth' : 'blink') : 'solid',
		cursorStyle: CURSOR[look.cursorStyle ?? 'bar']
	};
}

export function baseOptions(host: HTMLElement): Monaco.editor.IEditorOptions & {
	theme: string;
} {
	return {
		theme: MONACO_THEME,
		fontFamily: monoFontFor(host),
		fontLigatures: false,
		automaticLayout: true,
		scrollBeyondLastLine: false,
		padding: { top: 12, bottom: 12 },
		lineNumbersMinChars: 3,
		lineDecorationsWidth: 12,
		renderLineHighlight: 'line',
		renderLineHighlightOnlyWhenFocus: true,
		renderWhitespace: 'selection',
		roundedSelection: true,
		folding: true,
		showFoldingControls: 'mouseover',
		glyphMargin: false,
		overviewRulerBorder: false,
		overviewRulerLanes: 0,
		hideCursorInOverviewRuler: true,
		bracketPairColorization: { enabled: false },
		guides: { indentation: true, bracketPairs: false, highlightActiveIndentation: true },
		stickyScroll: { enabled: false },
		fixedOverflowWidgets: true,
		contextmenu: true,
		mouseWheelZoom: false,
		scrollbar: {
			useShadows: false,
			verticalScrollbarSize: 10,
			horizontalScrollbarSize: 10,
			verticalSliderSize: 6,
			horizontalSliderSize: 6
		}
	};
}
