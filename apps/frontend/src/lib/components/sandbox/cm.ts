import { EditorState, type Extension } from '@codemirror/state';
import {
	EditorView,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	rectangularSelection
} from '@codemirror/view';
import {
	HighlightStyle,
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	syntaxHighlighting
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';

const orchardTheme = EditorView.theme({
	'&': {
		height: '100%',
		color: 'var(--text-default)',
		backgroundColor: 'var(--bg-app)',
		fontSize: 'var(--text-caption)'
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': {
		fontFamily: 'var(--font-mono, monospace)',
		lineHeight: '1.6'
	},
	'.cm-content': {
		caretColor: 'var(--accent)',
		padding: '0.5rem 0'
	},
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
		backgroundColor: 'var(--accent-subtle)'
	},
	'.cm-selectionMatch': { backgroundColor: 'var(--bg-hover)' },
	'.cm-gutters': {
		backgroundColor: 'var(--bg-app)',
		color: 'var(--text-faint)',
		borderRight: '1px solid var(--border-default)'
	},
	'.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
	'.cm-activeLineGutter': {
		backgroundColor: 'var(--bg-hover)',
		color: 'var(--text-muted)'
	},
	'.cm-foldPlaceholder': {
		backgroundColor: 'var(--bg-raised)',
		border: '1px solid var(--border-default)',
		color: 'var(--text-muted)'
	},
	'.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
		backgroundColor: 'var(--accent-subtle)',
		outline: 'none'
	},
	'.cm-searchMatch': { backgroundColor: 'var(--status-warning-bg)' },
	'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-subtle)' },
	'.cm-panels': {
		backgroundColor: 'var(--bg-raised)',
		color: 'var(--text-default)',
		border: 'none',
		borderTop: '1px solid var(--border-default)',
		fontFamily: 'inherit',
		fontSize: 'var(--text-caption)'
	},
	'.cm-panels input, .cm-panels button': {
		backgroundColor: 'var(--bg-sunken)',
		color: 'var(--text-default)',
		border: '1px solid var(--border-default)',
		borderRadius: 'var(--radius-xs)',
		padding: '0.125rem 0.375rem'
	},
	'.cm-tooltip': {
		backgroundColor: 'var(--bg-overlay)',
		border: '1px solid var(--border-default)',
		borderRadius: 'var(--radius-sm)',
		color: 'var(--text-default)'
	}
});

const orchardHighlight = HighlightStyle.define([
	{ tag: [tags.keyword, tags.moduleKeyword, tags.controlKeyword], color: 'var(--hue-violet)' },
	{ tag: [tags.definitionKeyword, tags.modifier], color: 'var(--hue-violet)' },
	{ tag: [tags.string, tags.special(tags.string)], color: 'var(--hue-green)' },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--hue-amber)' },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--text-faint)' },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--hue-blue)' },
	{ tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], color: 'var(--text-default)' },
	{ tag: [tags.propertyName, tags.attributeName], color: 'var(--hue-blue)' },
	{ tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--hue-emerald)' },
	{ tag: [tags.tagName], color: 'var(--hue-pink)' },
	{ tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--text-muted)' },
	{ tag: [tags.variableName], color: 'var(--text-default)' },
	{ tag: [tags.regexp, tags.escape], color: 'var(--hue-amber)' },
	{ tag: [tags.link, tags.url], color: 'var(--text-link)', textDecoration: 'underline' },
	{ tag: tags.heading, color: 'var(--text-default)', fontWeight: '600' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.strong, fontWeight: '600' },
	{ tag: tags.strikethrough, textDecoration: 'line-through' },
	{ tag: [tags.invalid], color: 'var(--status-error)' },
	{ tag: [tags.meta, tags.processingInstruction], color: 'var(--text-muted)' }
]);

export function cmLanguage(path: string): Extension[] {
	const name = path.split('/').pop()?.toLowerCase() ?? '';
	const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';
	switch (ext) {
		case 'ts':
			return [javascript({ typescript: true })];
		case 'tsx':
			return [javascript({ typescript: true, jsx: true })];
		case 'jsx':
			return [javascript({ jsx: true })];
		case 'js':
		case 'mjs':
		case 'cjs':
			return [javascript()];
		case 'json':
		case 'jsonc':
			return [json()];
		case 'py':
			return [python()];
		case 'md':
		case 'mdx':
		case 'markdown':
			return [markdown()];
		case 'css':
		case 'scss':
		case 'less':
			return [css()];
		case 'html':
		case 'htm':
		case 'svelte':
		case 'vue':
			return [html()];
		case 'rs':
			return [rust()];
		case 'go':
			return [go()];
		default:
			return [];
	}
}

export function cmLanguageLabel(path: string): string {
	const name = path.split('/').pop()?.toLowerCase() ?? '';
	const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';
	const labels: Record<string, string> = {
		ts: 'TypeScript',
		tsx: 'TypeScript',
		js: 'JavaScript',
		mjs: 'JavaScript',
		cjs: 'JavaScript',
		jsx: 'JavaScript',
		json: 'JSON',
		jsonc: 'JSON',
		py: 'Python',
		md: 'Markdown',
		mdx: 'Markdown',
		markdown: 'Markdown',
		css: 'CSS',
		scss: 'CSS',
		less: 'CSS',
		html: 'HTML',
		htm: 'HTML',
		svelte: 'Svelte',
		vue: 'Vue',
		rs: 'Rust',
		go: 'Go',
		yml: 'YAML',
		yaml: 'YAML',
		sh: 'Shell',
		toml: 'TOML'
	};
	return labels[ext] ?? (ext ? ext.toUpperCase() : 'Plain text');
}

export function cmExtensions(opts: {
	path: string;
	readOnly: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
}): Extension[] {
	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		foldGutter(),
		history(),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		bracketMatching(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		rectangularSelection(),
		syntaxHighlighting(orchardHighlight),
		orchardTheme,
		EditorView.lineWrapping,
		...cmLanguage(opts.path),
		keymap.of([
			{
				key: 'Mod-s',
				preventDefault: true,
				run: () => {
					opts.onSave();
					return true;
				}
			},
			...defaultKeymap,
			...historyKeymap,
			...searchKeymap,
			...foldKeymap,
			indentWithTab
		]),
		EditorState.readOnly.of(opts.readOnly),
		EditorView.editable.of(!opts.readOnly),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) opts.onChange(update.state.doc.toString());
		})
	];
}
