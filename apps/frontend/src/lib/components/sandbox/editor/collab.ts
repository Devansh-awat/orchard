import type * as Monaco from 'monaco-editor';
import type { MonacoApi } from './load';
import { colorClass, ensureEditorStyles, safeColorVar } from './styles';

export interface CollabBinding {
	bind(model: Monaco.editor.ITextModel, editor: Monaco.editor.IStandaloneCodeEditor): () => void;
}

export interface RemoteSelection {
	startLine: number;
	startCol: number;
	endLine: number;
	endCol: number;
}

export interface RemoteCursor {
	userId: string;
	name: string;
	colorVar: string;
	line: number;
	col: number;
	selection?: RemoteSelection | null;
	path?: string;
}

export const REMOTE_COLOR_VARS = [
	'--hue-blue',
	'--hue-violet',
	'--hue-emerald',
	'--hue-amber',
	'--hue-pink',
	'--hue-green',
	'--hue-red',
	'--hue-slate'
] as const;

export function remoteColorVar(userId: string): string {
	let hash = 0;
	for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
	return REMOTE_COLOR_VARS[Math.abs(hash) % REMOTE_COLOR_VARS.length];
}

class RemoteCaret implements Monaco.editor.IContentWidget {
	readonly allowEditorOverflow = false;
	readonly suppressMouseDown = true;
	private readonly node: HTMLDivElement;
	private readonly label: HTMLSpanElement;
	private position: Monaco.IPosition = { lineNumber: 1, column: 1 };

	constructor(
		private readonly editor: Monaco.editor.IStandaloneCodeEditor,
		private readonly monaco: MonacoApi,
		readonly userId: string
	) {
		this.node = document.createElement('div');
		this.label = document.createElement('span');
		this.label.className = 'orchard-rc-label';
		this.node.appendChild(this.label);
		this.node.setAttribute('aria-hidden', 'true');
	}

	getId() {
		return `orchard.remote-caret.${this.userId}`;
	}

	getDomNode() {
		return this.node;
	}

	getPosition(): Monaco.editor.IContentWidgetPosition {
		return {
			position: this.position,
			preference: [this.monaco.editor.ContentWidgetPositionPreference.EXACT]
		};
	}

	update(cursor: RemoteCursor) {
		const lineHeight = this.editor.getOption(this.monaco.editor.EditorOption.lineHeight);
		this.position = { lineNumber: cursor.line, column: cursor.col };
		this.node.className = `orchard-rc-caret ${colorClass(cursor.colorVar)}${cursor.line <= 1 ? ' orchard-rc-caret--below' : ''}`;
		this.node.style.height = `${lineHeight}px`;
		this.label.textContent = cursor.name;
	}
}

export class RemoteCursorLayer {
	private readonly carets = new Map<string, RemoteCaret>();
	private readonly selections: Monaco.editor.IEditorDecorationsCollection;

	constructor(
		private readonly monaco: MonacoApi,
		private readonly editor: Monaco.editor.IStandaloneCodeEditor
	) {
		ensureEditorStyles();
		this.selections = editor.createDecorationsCollection();
	}

	update(cursors: readonly RemoteCursor[]) {
		const model = this.editor.getModel();
		if (!model) {
			this.clear();
			return;
		}
		const lines = model.getLineCount();
		const live = new Set<string>();
		const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
		for (const raw of cursors) {
			const line = Math.min(Math.max(1, raw.line), lines);
			const col = Math.min(Math.max(1, raw.col), model.getLineMaxColumn(line));
			const cursor = { ...raw, line, col, colorVar: safeColorVar(raw.colorVar) };
			live.add(cursor.userId);
			let caret = this.carets.get(cursor.userId);
			if (!caret) {
				caret = new RemoteCaret(this.editor, this.monaco, cursor.userId);
				this.carets.set(cursor.userId, caret);
				caret.update(cursor);
				this.editor.addContentWidget(caret);
			} else {
				caret.update(cursor);
				this.editor.layoutContentWidget(caret);
			}
			const sel = cursor.selection;
			if (sel && (sel.startLine !== sel.endLine || sel.startCol !== sel.endCol)) {
				decorations.push({
					range: new this.monaco.Range(sel.startLine, sel.startCol, sel.endLine, sel.endCol),
					options: {
						className: `orchard-rc-sel ${colorClass(cursor.colorVar)}`,
						stickiness: this.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
						hoverMessage: { value: cursor.name }
					}
				});
			}
		}
		for (const [id, caret] of this.carets) {
			if (live.has(id)) continue;
			this.editor.removeContentWidget(caret);
			this.carets.delete(id);
		}
		this.selections.set(decorations);
	}

	clear() {
		for (const caret of this.carets.values()) this.editor.removeContentWidget(caret);
		this.carets.clear();
		this.selections.clear();
	}

	dispose() {
		this.clear();
	}
}
