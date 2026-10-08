import type * as Monaco from 'monaco-editor';

export type MonacoApi = typeof Monaco;

type WorkerCtor = new () => Worker;

let loading: Promise<MonacoApi> | null = null;
let loaded: MonacoApi | null = null;

function workerFor(label: string, workers: Record<string, WorkerCtor>): Worker {
	if (label === 'json') return new workers.json();
	if (label === 'css' || label === 'scss' || label === 'less') return new workers.css();
	if (label === 'html' || label === 'handlebars' || label === 'razor') return new workers.html();
	if (label === 'typescript' || label === 'javascript') return new workers.ts();
	return new workers.editor();
}

function configure(monaco: MonacoApi) {
	for (const defaults of [
		monaco.typescript.typescriptDefaults,
		monaco.typescript.javascriptDefaults
	]) {
		defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
		defaults.setEagerModelSync(true);
	}
}

export function monacoLoaded(): MonacoApi | null {
	return loaded;
}

export function loadMonaco(): Promise<MonacoApi> {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('Monaco only runs in the browser'));
	}
	loading ??= Promise.all([
		import('monaco-editor/editor/editor.worker?worker'),
		import('monaco-editor/language/json/json.worker?worker'),
		import('monaco-editor/language/css/css.worker?worker'),
		import('monaco-editor/language/html/html.worker?worker'),
		import('monaco-editor/language/typescript/ts.worker?worker')
	])
		.then(async ([editor, json, css, html, ts]) => {
			const workers: Record<string, WorkerCtor> = {
				editor: editor.default,
				json: json.default,
				css: css.default,
				html: html.default,
				ts: ts.default
			};
			self.MonacoEnvironment = {
				getWorker: (_id: string, label: string) => workerFor(label, workers)
			};
			const monaco = await import('monaco-editor');
			configure(monaco);
			loaded = monaco;
			return monaco;
		})
		.catch((err) => {
			loading = null;
			throw err;
		});
	return loading;
}
