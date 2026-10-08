import type * as Monaco from 'monaco-editor';
import { mount, unmount } from 'svelte';
import DiffThread from './DiffThread.svelte';
import type { MonacoApi } from './load';
import { ensureEditorStyles } from './styles';
import type { DiffThreadProps } from './types';

export type ThreadState = Omit<
	DiffThreadProps,
	'onsubmit' | 'oncancel' | 'onreply' | 'onremove' | 'ondraftinput'
>;

export interface ThreadHandlers {
	submit(line: number, body: string): void;
	cancel(line: number): void;
	reply(line: number): void;
	remove(id: string): void;
	draftInput(line: number, body: string): void;
}

let sequence = 0;
const HIDDEN = -100000;

class ThreadZone {
	readonly props: DiffThreadProps;
	private readonly node: HTMLDivElement;
	private readonly overlay: Monaco.editor.IOverlayWidget;
	private readonly zone: Monaco.editor.IViewZone;
	private readonly component: ReturnType<typeof mount>;
	private readonly observer: ResizeObserver;
	private readonly layoutListener: Monaco.IDisposable;
	private zoneId: string | null = null;
	private shown = false;

	constructor(
		private readonly editor: Monaco.editor.ICodeEditor,
		readonly line: number,
		state: ThreadState,
		handlers: ThreadHandlers
	) {
		const id = `orchard.diff-thread.${++sequence}`;
		this.node = document.createElement('div');
		this.node.className = 'orchard-diff-thread';
		this.node.style.top = `${HIDDEN}px`;
		this.node.style.visibility = 'hidden';
		this.node.addEventListener('keydown', (e) => e.stopPropagation());
		this.node.addEventListener('mousedown', (e) => e.stopPropagation());
		this.overlay = {
			getId: () => id,
			getDomNode: () => this.node,
			getPosition: () => null
		};
		this.props = $state({
			...state,
			onsubmit: (body: string) => handlers.submit(line, body),
			oncancel: () => handlers.cancel(line),
			onreply: () => handlers.reply(line),
			onremove: (commentId: string) => handlers.remove(commentId),
			ondraftinput: (body: string) => handlers.draftInput(line, body)
		});
		editor.addOverlayWidget(this.overlay);
		this.place();
		this.component = mount(DiffThread, { target: this.node, props: this.props });
		this.zone = {
			afterLineNumber: line,
			heightInPx: this.measure(),
			domNode: document.createElement('div'),
			suppressMouseDown: true,
			onDomNodeTop: (top) => {
				const offscreen = top <= HIDDEN;
				this.node.style.top = `${offscreen ? HIDDEN : top}px`;
				this.node.style.visibility = offscreen ? 'hidden' : '';
				if (!offscreen && !this.shown) this.reveal();
				this.shown = !offscreen;
			}
		};
		editor.changeViewZones((acc) => {
			this.zoneId = acc.addZone(this.zone);
		});
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(this.node);
		this.layoutListener = editor.onDidLayoutChange(() => {
			this.place();
			this.resize();
		});
		requestAnimationFrame(() => this.resize());
		void document.fonts?.ready.then(() => this.resize());
	}

	private reveal() {
		if (!this.props.drafting) return;
		this.node.querySelector('textarea')?.focus({ preventScroll: true });
	}

	private measure(): number {
		return Math.max(48, Math.ceil(this.node.getBoundingClientRect().height));
	}

	update(state: ThreadState) {
		Object.assign(this.props, state);
	}

	private place() {
		const info = this.editor.getLayoutInfo();
		const width =
			info.width - info.contentLeft - info.minimap.minimapWidth - info.verticalScrollbarWidth;
		this.node.style.left = `${info.contentLeft}px`;
		this.node.style.width = `${Math.max(160, width)}px`;
	}

	private resize() {
		if (!this.zoneId) return;
		const height = this.measure();
		if (height === this.zone.heightInPx) return;
		this.zone.heightInPx = height;
		this.editor.changeViewZones((acc) => {
			if (this.zoneId) acc.layoutZone(this.zoneId);
		});
	}

	dispose() {
		this.observer.disconnect();
		this.layoutListener.dispose();
		this.editor.changeViewZones((acc) => {
			if (this.zoneId) acc.removeZone(this.zoneId);
		});
		this.zoneId = null;
		this.editor.removeOverlayWidget(this.overlay);
		void unmount(this.component);
	}
}

export class DiffThreads {
	private readonly zones = new Map<number, ThreadZone>();
	private readonly hover: Monaco.editor.IEditorDecorationsCollection;
	private readonly marks: Monaco.editor.IEditorDecorationsCollection;
	private readonly listeners: Monaco.IDisposable[] = [];
	private hoverLine: number | null = null;

	constructor(
		private readonly monaco: MonacoApi,
		private readonly editor: Monaco.editor.ICodeEditor,
		private readonly handlers: ThreadHandlers & { open(line: number): void },
		private readonly enabled: () => boolean
	) {
		ensureEditorStyles();
		this.hover = editor.createDecorationsCollection();
		this.marks = editor.createDecorationsCollection();
		const { MouseTargetType } = monaco.editor;
		const targets = new Set([
			MouseTargetType.GUTTER_GLYPH_MARGIN,
			MouseTargetType.GUTTER_LINE_NUMBERS,
			MouseTargetType.GUTTER_LINE_DECORATIONS,
			MouseTargetType.CONTENT_TEXT,
			MouseTargetType.CONTENT_EMPTY
		]);
		this.listeners.push(
			editor.onMouseMove((e) => {
				const line = e.target.position?.lineNumber ?? null;
				this.setHover(this.enabled() && targets.has(e.target.type) ? line : null);
			}),
			editor.onMouseLeave(() => this.setHover(null)),
			editor.onMouseDown((e) => {
				if (!this.enabled()) return;
				if (e.target.type !== MouseTargetType.GUTTER_GLYPH_MARGIN) return;
				const line = e.target.position?.lineNumber;
				if (!line) return;
				e.event.preventDefault();
				this.handlers.open(line);
			})
		);
	}

	private setHover(line: number | null) {
		if (line === this.hoverLine) return;
		this.hoverLine = line;
		if (line === null || this.zones.has(line)) {
			this.hover.clear();
			return;
		}
		this.hover.set([
			{
				range: new this.monaco.Range(line, 1, line, 1),
				options: { glyphMarginClassName: 'orchard-diff-plus' }
			}
		]);
	}

	sync(threads: Map<number, ThreadState>, commented: Iterable<number>) {
		const model = this.editor.getModel();
		const lines = model?.getLineCount() ?? 0;
		for (const [line, zone] of this.zones) {
			if (threads.has(line) && line <= lines) continue;
			zone.dispose();
			this.zones.delete(line);
		}
		for (const [line, state] of threads) {
			if (line > lines) continue;
			const existing = this.zones.get(line);
			if (existing) existing.update(state);
			else this.zones.set(line, new ThreadZone(this.editor, line, state, this.handlers));
		}
		this.marks.set(
			[...commented]
				.filter((line) => line <= lines)
				.map((line) => ({
					range: new this.monaco.Range(line, 1, line, 1),
					options: { isWholeLine: true, className: 'orchard-diff-commented' }
				}))
		);
		if (this.hoverLine !== null && this.zones.has(this.hoverLine)) this.hover.clear();
	}

	dispose() {
		for (const zone of this.zones.values()) zone.dispose();
		this.zones.clear();
		for (const listener of this.listeners) listener.dispose();
		this.hover.clear();
		this.marks.clear();
	}
}
