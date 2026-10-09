import type * as Monaco from 'monaco-editor';
import type { EffectiveAnimationLevel } from '$lib/stores/preferences';
import type { TerminalCursor } from '$lib/stores/terminal-display.svelte';
import { monoFontFor } from '$lib/terminal/font';
import type { MonacoApi } from './load';
import { MONACO_THEME } from './theme';

export interface LookOptions {
	fontSize: number;
	fontFamily?: string;
	ligatures?: boolean;
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
	const blink = look.cursorBlink !== false && look.motion !== 'off';
	return {
		fontSize: look.fontSize,
		...(look.fontFamily ? { fontFamily: look.fontFamily } : {}),
		fontLigatures: look.ligatures ?? false,
		lineHeight: Math.round(look.fontSize * 1.65),
		cursorSmoothCaretAnimation: 'off',
		smoothScrolling: false,
		cursorBlinking: blink ? 'blink' : 'solid',
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

export async function settleFont(monaco: MonacoApi, family: string, sizePx: number): Promise<void> {
	const first = family.split(',')[0]?.trim();
	if (first && typeof document !== 'undefined' && document.fonts?.load) {
		try {
			await document.fonts.load(`${sizePx}px ${first}`);
		} catch {}
	}
	monaco.editor.remeasureFonts();
}
