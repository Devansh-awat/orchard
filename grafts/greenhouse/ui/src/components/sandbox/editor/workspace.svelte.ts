import type * as Monaco from 'monaco-editor';
import { loadMonaco, type MonacoApi } from './load';
import { languageForPath } from './languages';

export interface EditorFs {
  readFile(path: string, opts?: { ref?: string }): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export type DocumentUri = `file://${string}`;

export function toDocumentUri(path: string): DocumentUri {
  if (path.startsWith('file://')) return path as DocumentUri;
  const absolute = path.startsWith('/') ? path : `/${path}`;
  return `file://${absolute}`;
}

export function toFsPath(uriOrPath: string): string {
  return uriOrPath.startsWith('file://') ? uriOrPath.slice('file://'.length) : uriOrPath;
}

export function baseName(path: string): string {
  const clean = toFsPath(path);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export class EditorDocument {
  readonly uri: DocumentUri;
  readonly path: string;
  readonly name: string;
  language = $state('plaintext');
  loading = $state(true);
  saving = $state(false);
  error = $state<string | null>(null);
  stale = $state(false);
  version = $state(0);
  savedVersion = $state(0);
  dirty = $derived(this.version !== this.savedVersion);
  model: Monaco.editor.ITextModel | null = null;
  viewState: Monaco.editor.ICodeEditorViewState | null = null;
  ready: Promise<void>;
  private settle!: () => void;

  constructor(uri: DocumentUri) {
    this.uri = uri;
    this.path = toFsPath(uri);
    this.name = baseName(uri);
    this.language = languageForPath(this.path);
    this.ready = new Promise((resolve) => (this.settle = resolve));
  }

  attach(model: Monaco.editor.ITextModel) {
    this.model = model;
    this.language = model.getLanguageId();
    this.markSaved();
    model.onDidChangeContent(() => {
      this.version = model.getAlternativeVersionId();
    });
    model.onDidChangeLanguage(() => {
      this.language = model.getLanguageId();
    });
    this.loading = false;
    this.settle();
  }

  fail(message: string) {
    this.error = message;
    this.loading = false;
    this.settle();
  }

  markSaved(version = this.model?.getAlternativeVersionId() ?? 0) {
    this.savedVersion = version;
    this.version = this.model?.getAlternativeVersionId() ?? version;
  }
}

export interface OpenOptions {
  activate?: boolean;
}

export class EditorWorkspace {
  documents = $state<EditorDocument[]>([]);
  activeUri = $state<DocumentUri | null>(null);
  active = $derived(this.documents.find((doc) => doc.uri === this.activeUri) ?? null);
  dirtyCount = $derived(this.documents.filter((doc) => doc.dirty).length);
  monaco = $state.raw<MonacoApi | null>(null);
  saveHook: ((path: string) => boolean) | null = null;

  private readonly fs: EditorFs;
  private readonly originals = new Map<string, Monaco.editor.ITextModel>();
  private loading: Promise<MonacoApi> | null = null;

  constructor(fs: EditorFs) {
    this.fs = fs;
  }

  ready(): Promise<MonacoApi> {
    this.loading ??= loadMonaco().then((monaco) => {
      this.monaco = monaco;
      return monaco;
    });
    return this.loading;
  }

  get(path: string): EditorDocument | null {
    const uri = toDocumentUri(path);
    return this.documents.find((doc) => doc.uri === uri) ?? null;
  }

  isDirty(path: string): boolean {
    return this.get(path)?.dirty ?? false;
  }

  open(path: string, opts: OpenOptions = {}): EditorDocument {
    const uri = toDocumentUri(path);
    let doc = this.documents.find((d) => d.uri === uri);
    if (!doc) {
      doc = new EditorDocument(uri);
      this.documents.push(doc);
      void this.load(doc);
    }
    if (opts.activate !== false) this.activeUri = uri;
    return doc;
  }

  activate(path: string) {
    const uri = toDocumentUri(path);
    if (this.documents.some((doc) => doc.uri === uri)) this.activeUri = uri;
  }

  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    if (from >= this.documents.length || to >= this.documents.length) return;
    const [doc] = this.documents.splice(from, 1);
    this.documents.splice(to, 0, doc);
  }

  close(path: string, opts: { force?: boolean } = {}): boolean {
    const uri = toDocumentUri(path);
    const index = this.documents.findIndex((doc) => doc.uri === uri);
    if (index < 0) return true;
    const doc = this.documents[index];
    if (doc.dirty && !opts.force) return false;
    this.documents.splice(index, 1);
    doc.model?.dispose();
    doc.model = null;
    this.dropOriginals(doc.path);
    if (this.activeUri === uri) {
      const next = this.documents[index] ?? this.documents[index - 1] ?? null;
      this.activeUri = next?.uri ?? null;
    }
    return true;
  }

  async save(path?: string): Promise<boolean> {
    const doc = path ? this.get(path) : this.active;
    if (!doc?.model || doc.saving) return false;
    if (this.saveHook?.(doc.path)) return true;
    const content = doc.model.getValue();
    const version = doc.model.getAlternativeVersionId();
    doc.saving = true;
    doc.error = null;
    try {
      await this.fs.writeFile(doc.path, content);
      doc.markSaved(version);
      doc.stale = false;
      return true;
    } catch (err) {
      doc.error = err instanceof Error ? err.message : "Couldn't save";
      return false;
    } finally {
      doc.saving = false;
    }
  }

  async saveAll(): Promise<boolean> {
    const results = await Promise.all(
      this.documents.filter((doc) => doc.dirty).map((doc) => this.save(doc.path))
    );
    return results.every(Boolean);
  }

  async reload(path: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const doc = this.get(path);
    if (!doc) return false;
    await doc.ready;
    if (!doc.model) return false;
    if (doc.dirty && !opts.force) {
      doc.stale = true;
      return false;
    }
    const content = await this.fs.readFile(doc.path);
    const model = doc.model;
    if (model.getValue() !== content) {
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: content }],
        () => null
      );
    }
    doc.markSaved();
    doc.stale = false;
    this.dropOriginals(doc.path);
    return true;
  }

  externalChange(path: string): Promise<boolean> {
    return this.reload(path);
  }

  async original(path: string, ref = 'HEAD'): Promise<Monaco.editor.ITextModel> {
    const monaco = await this.ready();
    const fsPath = toFsPath(toDocumentUri(path));
    const key = `${ref}\u0000${fsPath}`;
    const cached = this.originals.get(key);
    if (cached && !cached.isDisposed()) return cached;
    let content = '';
    try {
      content = await this.fs.readFile(fsPath, { ref });
    } catch {
      content = '';
    }
    const uri = monaco.Uri.from({ scheme: 'orchard-ref', path: fsPath, query: ref });
    const existing = monaco.editor.getModel(uri);
    const model = existing ?? monaco.editor.createModel(content, undefined, uri);
    if (existing) existing.setValue(content);
    this.originals.set(key, model);
    return model;
  }

  viewState(path: string): Monaco.editor.ICodeEditorViewState | null {
    return this.get(path)?.viewState ?? null;
  }

  rememberViewState(path: string, state: Monaco.editor.ICodeEditorViewState | null) {
    const doc = this.get(path);
    if (doc) doc.viewState = state;
  }

  dispose() {
    for (const doc of this.documents) doc.model?.dispose();
    for (const model of this.originals.values()) model.dispose();
    this.originals.clear();
    this.documents = [];
    this.activeUri = null;
  }

  private dropOriginals(fsPath: string) {
    for (const [key, model] of this.originals) {
      if (!key.endsWith(`\u0000${fsPath}`)) continue;
      model.dispose();
      this.originals.delete(key);
    }
  }

  private async load(doc: EditorDocument) {
    try {
      const [monaco, content] = await Promise.all([this.ready(), this.fs.readFile(doc.path)]);
      if (!this.documents.includes(doc)) return;
      const uri = monaco.Uri.parse(doc.uri);
      const existing = monaco.editor.getModel(uri);
      const language = languageForPath(doc.path, monaco);
      const model = existing ?? monaco.editor.createModel(content, language, uri);
      if (existing) existing.setValue(content);
      doc.attach(model);
    } catch (err) {
      doc.fail(err instanceof Error ? err.message : "Couldn't open file");
    }
  }
}
