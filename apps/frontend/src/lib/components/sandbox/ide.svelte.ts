import { toasts } from '$lib/stores';
import { ideReadFile, ideWriteFile } from './ide';

export type EditorTab = {
	key: string;
	repo: string | null;
	path: string;
	name: string;
	content: string;
	saved: string;
	rev: number;
	loading: boolean;
	saving: boolean;
	truncated: boolean;
	readOnly: boolean;
	error: string | null;
};

function tabKey(repo: string | null, path: string): string {
	return `${repo ?? ''}:${path}`;
}

export class SandboxIde {
	sandboxId = $state('');
	tabs = $state<EditorTab[]>([]);
	activeKey = $state<string | null>(null);

	constructor(sandboxId: string) {
		this.sandboxId = sandboxId;
	}

	get active(): EditorTab | null {
		return this.tabs.find((t) => t.key === this.activeKey) ?? null;
	}

	get dirtyCount(): number {
		return this.tabs.filter((t) => t.content !== t.saved).length;
	}

	isDirty(tab: EditorTab): boolean {
		return !tab.loading && tab.content !== tab.saved;
	}

	async open(repo: string | null, path: string) {
		const key = tabKey(repo, path);
		const existing = this.tabs.find((t) => t.key === key);
		this.activeKey = key;
		if (existing) return;
		const tab: EditorTab = {
			key,
			repo,
			path,
			name: path.split('/').pop() || path,
			content: '',
			saved: '',
			rev: 0,
			loading: true,
			saving: false,
			truncated: false,
			readOnly: false,
			error: null
		};
		this.tabs.push(tab);
		const result = await ideReadFile(this.sandboxId, repo, path);
		const live = this.tabs.find((t) => t.key === key);
		if (!live) return;
		if (!result.ok || !result.data) {
			live.loading = false;
			live.readOnly = true;
			live.error = result.message ?? 'Could not read that file';
			live.rev += 1;
			return;
		}
		live.content = result.data.content;
		live.saved = result.data.content;
		live.truncated = result.data.truncated;
		live.loading = false;
		live.rev += 1;
	}

	close(key: string) {
		const index = this.tabs.findIndex((t) => t.key === key);
		if (index === -1) return;
		this.tabs.splice(index, 1);
		if (this.activeKey !== key) return;
		const next = this.tabs[index] ?? this.tabs[index - 1] ?? null;
		this.activeKey = next?.key ?? null;
	}

	closeAll() {
		this.tabs = [];
		this.activeKey = null;
	}

	setContent(key: string, content: string) {
		const tab = this.tabs.find((t) => t.key === key);
		if (!tab) return;
		tab.content = content;
	}

	async save(key: string): Promise<boolean> {
		const tab = this.tabs.find((t) => t.key === key);
		if (!tab || tab.saving || tab.loading || tab.readOnly) return false;
		if (tab.content === tab.saved) return true;
		tab.saving = true;
		const pending = tab.content;
		const result = await ideWriteFile(this.sandboxId, tab.repo, tab.path, pending);
		const live = this.tabs.find((t) => t.key === key);
		if (!live) return false;
		live.saving = false;
		if (result.ok) {
			live.saved = pending;
			live.error = null;
			toasts.add({ title: 'Saved', description: live.path, color: 'success' });
			return true;
		}
		if (result.status === 404) {
			live.readOnly = true;
			live.error = 'Saving is not available on this server yet';
			toasts.add({
				title: 'Read only',
				description: 'This server does not support writing sandbox files yet',
				color: 'warning'
			});
			return false;
		}
		live.error = result.message ?? 'Could not save that file';
		toasts.add({ title: 'Save failed', description: live.error, color: 'error' });
		return false;
	}
}
