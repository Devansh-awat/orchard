import { toFsPath } from './workspace.svelte';

export type DiffSide = 'original' | 'modified';

export interface CommentAuthor {
  id: string;
  name: string;
}

export interface DiffComment {
  id: string;
  path: string;
  line: number;
  side: DiffSide;
  body: string;
  author?: CommentAuthor;
  lineText?: string;
  createdAt: number;
}

export interface RemoteDraftComment {
  userId: string;
  name: string;
  colorVar?: string;
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

export interface LocalDraft {
  path: string;
  line: number;
  side: DiffSide;
  body: string;
}

export type NewDiffComment = Omit<DiffComment, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

export interface PromptOptions {
  intro?: string;
  root?: string;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function displayPath(path: string, root?: string): string {
  const fsPath = toFsPath(path);
  if (root && fsPath.startsWith(`${root.replace(/\/$/, '')}/`)) {
    return fsPath.slice(root.replace(/\/$/, '').length + 1);
  }
  return fsPath;
}

function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(1, longest + 1));
}

export class DiffComments {
  items = $state<DiffComment[]>([]);
  count = $derived(this.items.length);

  add(input: NewDiffComment): DiffComment {
    const comment: DiffComment = {
      ...input,
      path: toFsPath(input.path),
      body: input.body.trim(),
      id: input.id ?? makeId(),
      createdAt: input.createdAt ?? Date.now()
    };
    this.items.push(comment);
    return comment;
  }

  update(id: string, body: string) {
    const comment = this.items.find((c) => c.id === id);
    if (comment) comment.body = body.trim();
  }

  remove(id: string) {
    const index = this.items.findIndex((c) => c.id === id);
    if (index >= 0) this.items.splice(index, 1);
  }

  replace(comments: DiffComment[]) {
    this.items = comments.map((c) => ({ ...c, path: toFsPath(c.path) }));
  }

  forPath(path: string): DiffComment[] {
    const fsPath = toFsPath(path);
    return this.items.filter((c) => c.path === fsPath);
  }

  at(path: string, side: DiffSide, line: number): DiffComment[] {
    const fsPath = toFsPath(path);
    return this.items.filter((c) => c.path === fsPath && c.side === side && c.line === line);
  }

  clear(path?: string) {
    if (!path) {
      this.items = [];
      return;
    }
    const fsPath = toFsPath(path);
    this.items = this.items.filter((c) => c.path !== fsPath);
  }

  toPrompt(opts: PromptOptions = {}): string {
    if (this.items.length === 0) return '';
    const byFile = new Map<string, DiffComment[]>();
    for (const comment of this.items) {
      const key = displayPath(comment.path, opts.root);
      const list = byFile.get(key) ?? [];
      list.push(comment);
      byFile.set(key, list);
    }
    const files = [...byFile.keys()].sort();
    const total = this.items.length;
    const lines: string[] = [
      opts.intro ??
        `Please address ${total === 1 ? 'this review comment' : `these ${total} review comments`} on your changes. Each one is anchored to a line of the diff.`,
      ''
    ];
    for (const file of files) {
      lines.push(`## ${file}`, '');
      const comments = byFile
        .get(file)!
        .slice()
        .sort((a, b) => a.line - b.line || a.createdAt - b.createdAt);
      for (const c of comments) {
        const where = c.side === 'original' ? `old line ${c.line} (removed)` : `line ${c.line}`;
        const who = c.author ? ` from ${c.author.name}` : '';
        lines.push(`- ${where}${who}`);
        const snippet = c.lineText?.trim();
        if (snippet) {
          const tick = fence(snippet);
          lines.push(
            `  ${tick}${tick.length > 1 ? ' ' : ''}${snippet}${tick.length > 1 ? ' ' : ''}${tick}`
          );
        }
        for (const bodyLine of c.body.split('\n')) lines.push(`  ${bodyLine}`);
        lines.push('');
      }
    }
    return lines.join('\n').trimEnd();
  }
}
