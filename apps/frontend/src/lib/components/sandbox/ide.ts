import { apiFetch } from '$lib/stores';
import { ocBase, ocDirectory } from './opencode';

export type IdeFileNode = {
	name: string;
	path: string;
	absolute: string;
	type: 'file' | 'directory';
	ignored: boolean;
};

export type IdeLspStatus = {
	id: string;
	name: string;
	root: string;
	status: 'connected' | 'error';
};

export type IdeChangedFile = {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
};

export type IdeChanges = { isRepo: boolean; branch: string | null; files: IdeChangedFile[] };

export type IdeResult<T> = { ok: boolean; status: number; data: T | null; message: string | null };

const IDE_HOME = '/persist/home';

function ideDir(repo: string | null): string {
	return ocDirectory(repo) ?? IDE_HOME;
}

function ideQuery(repo: string | null, extra?: Record<string, string>): string {
	const params = new URLSearchParams({ directory: ideDir(repo) });
	for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
	return params.toString();
}

async function ideJson<T>(path: string, fallback: T): Promise<T> {
	try {
		const res = await apiFetch(path);
		if (!res.ok) {
			res.body?.cancel();
			return fallback;
		}
		return (await res.json()) as T;
	} catch {
		return fallback;
	}
}

async function ideSend<T>(
	path: string,
	method: 'POST' | 'PUT',
	body: unknown
): Promise<IdeResult<T>> {
	try {
		const res = await apiFetch(path, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
		return {
			ok: res.ok,
			status: res.status,
			data: res.ok ? ((data ?? null) as T | null) : null,
			message: res.ok ? null : (data?.message ?? `Request failed with ${res.status}`)
		};
	} catch (e) {
		return {
			ok: false,
			status: 0,
			data: null,
			message: e instanceof Error ? e.message : 'Request failed'
		};
	}
}

export function ideListFiles(
	sandboxId: string,
	repo: string | null,
	path: string
): Promise<IdeFileNode[]> {
	const query = ideQuery(repo, { path });
	return ideJson<IdeFileNode[]>(`${ocBase(sandboxId)}/file?${query}`, []);
}

export function ideFindFiles(
	sandboxId: string,
	repo: string | null,
	query: string,
	limit = 30
): Promise<string[]> {
	const qs = ideQuery(repo, { query, limit: String(limit) });
	return ideJson<string[]>(`${ocBase(sandboxId)}/find/file?${qs}`, []);
}

export function ideLspStatus(sandboxId: string, repo: string | null): Promise<IdeLspStatus[]> {
	return ideJson<IdeLspStatus[]>(`${ocBase(sandboxId)}/lsp?${ideQuery(repo)}`, []);
}

export async function ideVcsBranch(sandboxId: string, repo: string | null): Promise<string | null> {
	const info = await ideJson<{ branch?: string | null }>(
		`${ocBase(sandboxId)}/vcs?${ideQuery(repo)}`,
		{}
	);
	return info.branch ?? null;
}

export async function ideChanges(
	sandboxId: string,
	repo: string | null
): Promise<IdeResult<IdeChanges>> {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
	try {
		const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/changes${qs}`);
		const data = (await res.json().catch(() => null)) as
			| (IdeChanges & { message?: string })
			| null;
		return {
			ok: res.ok,
			status: res.status,
			data: res.ok ? data : null,
			message: res.ok ? null : (data?.message ?? 'Failed to load changes')
		};
	} catch (e) {
		return {
			ok: false,
			status: 0,
			data: null,
			message: e instanceof Error ? e.message : 'Failed to load changes'
		};
	}
}

export async function ideDiff(
	sandboxId: string,
	repo: string | null,
	file: string | null
): Promise<IdeResult<{ diff: string; truncated?: boolean }>> {
	const params = new URLSearchParams();
	if (file) params.set('file', file);
	if (repo) params.set('repo', repo);
	const qs = params.size > 0 ? `?${params.toString()}` : '';
	try {
		const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/diff${qs}`);
		const data = (await res.json().catch(() => null)) as {
			diff?: string;
			truncated?: boolean;
			message?: string;
		} | null;
		return {
			ok: res.ok,
			status: res.status,
			data: res.ok ? { diff: data?.diff ?? '', truncated: data?.truncated } : null,
			message: res.ok ? null : (data?.message ?? 'Failed to load diff')
		};
	} catch (e) {
		return {
			ok: false,
			status: 0,
			data: null,
			message: e instanceof Error ? e.message : 'Failed to load diff'
		};
	}
}

export async function ideReadFile(
	sandboxId: string,
	repo: string | null,
	path: string
): Promise<IdeResult<{ content: string; truncated: boolean }>> {
	const params = new URLSearchParams({ path });
	if (repo) params.set('repo', repo);
	try {
		const res = await apiFetch(`/apiv1/sandboxes/${sandboxId}/file?${params.toString()}`);
		const data = (await res.json().catch(() => null)) as {
			content?: string;
			truncated?: boolean;
			message?: string;
		} | null;
		return {
			ok: res.ok,
			status: res.status,
			data: res.ok ? { content: data?.content ?? '', truncated: data?.truncated === true } : null,
			message: res.ok ? null : (data?.message ?? 'Could not read that file')
		};
	} catch (e) {
		return {
			ok: false,
			status: 0,
			data: null,
			message: e instanceof Error ? e.message : 'Could not read that file'
		};
	}
}

export function ideWriteFile(
	sandboxId: string,
	repo: string | null,
	path: string,
	content: string
): Promise<IdeResult<{ ok: boolean }>> {
	return ideSend(`/apiv1/sandboxes/${sandboxId}/file`, 'PUT', { repo, path, content });
}

export function ideGitCommit(
	sandboxId: string,
	repo: string,
	message: string,
	files?: string[]
): Promise<IdeResult<{ ok: boolean; output: string }>> {
	return ideSend(`/apiv1/sandboxes/${sandboxId}/git/commit`, 'POST', {
		repo,
		message,
		...(files?.length ? { files } : {})
	});
}

export function ideGitPush(
	sandboxId: string,
	repo: string
): Promise<IdeResult<{ ok: boolean; output: string }>> {
	return ideSend(`/apiv1/sandboxes/${sandboxId}/git/push`, 'POST', { repo });
}

export function ideGitPr(
	sandboxId: string,
	repo: string,
	title: string,
	body?: string
): Promise<IdeResult<{ url: string }>> {
	return ideSend(`/apiv1/sandboxes/${sandboxId}/git/pr`, 'POST', {
		repo,
		title,
		...(body?.trim() ? { body } : {})
	});
}

export function ideStatusKind(status: string): string {
	if (status.includes('?')) return 'untracked';
	if (status.includes('A')) return 'added';
	if (status.includes('D')) return 'deleted';
	if (status.includes('R')) return 'renamed';
	return 'modified';
}

export function ideMidTruncate(path: string, max = 46): string {
	if (path.length <= max) return path;
	const head = Math.ceil((max - 1) * 0.45);
	return `${path.slice(0, head)}…${path.slice(path.length - (max - 1 - head))}`;
}
