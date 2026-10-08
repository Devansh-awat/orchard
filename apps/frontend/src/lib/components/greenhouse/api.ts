import { apiFetch } from '$lib/stores';
import type {
	GhChanges,
	GhChat,
	GhChecks,
	GhConnect,
	GhEnvironment,
	GhFileNode,
	GhGitIdentity,
	GhIssue,
	GhMembers,
	GhOrchardProject,
	GhPort,
	GhPreviewResult,
	GhProjectLink,
	GhRepo,
	GhSession,
	GhShareLink,
	IssueProvider,
	LiveComment,
	PersonRef
} from './types';

export const GH_HOME = '/persist/home';

export class GhApiError extends Error {
	readonly status: number;
	readonly code: string | null;
	constructor(message: string, status: number, code: string | null = null) {
		super(message);
		this.name = 'GhApiError';
		this.status = status;
		this.code = code;
	}
}

export const GITHUB_NOT_LINKED = 'github_not_linked';
export const LINK_GITHUB_HREF = '/user/settings?tab=connections';

export function isGithubUnlinked(error: unknown): boolean {
	return error instanceof GhApiError && error.code === GITHUB_NOT_LINKED;
}

export type Maybe<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

function base(sandboxId: string): string {
	return `/apiv1/sandboxes/${encodeURIComponent(sandboxId)}`;
}

async function readError(
	res: Response,
	fallback: string
): Promise<{ message: string; code: string | null }> {
	const body = (await res.json().catch(() => null)) as {
		message?: string | string[];
		code?: string;
	} | null;
	const message = Array.isArray(body?.message) ? body?.message.join(', ') : body?.message;
	return { message: message || fallback, code: typeof body?.code === 'string' ? body.code : null };
}

async function readMessage(res: Response, fallback: string): Promise<string> {
	return (await readError(res, fallback)).message;
}

async function get<T>(path: string): Promise<Maybe<T>> {
	try {
		const res = await apiFetch(path);
		if (!res.ok) {
			return { ok: false, status: res.status, message: await readMessage(res, 'Request failed') };
		}
		return { ok: true, data: (await res.json()) as T };
	} catch (e) {
		return { ok: false, status: 0, message: e instanceof Error ? e.message : 'Request failed' };
	}
}

async function send<T>(
	path: string,
	method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
	body?: unknown
): Promise<T> {
	const res = await apiFetch(path, {
		method,
		headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) {
		const error = await readError(res, 'Request failed');
		throw new GhApiError(error.message, res.status, error.code);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

export type Scope = { session?: string | null; repo?: string | null };

function scoped(scope: Scope): { session?: string; repo?: string } {
	if (scope.session) return { session: scope.session };
	return scope.repo ? { repo: scope.repo } : {};
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === null || value === undefined || value === false || value === '') continue;
		search.set(key, String(value));
	}
	const out = search.toString();
	return out ? `?${out}` : '';
}

export function listSessions(sandboxId: string, includeArchived = true) {
	return get<{ sessions: GhSession[] }>(
		`${base(sandboxId)}/sessions${qs({ includeArchived: includeArchived ? 1 : null })}`
	);
}

export function createSession(
	sandboxId: string,
	body: {
		repo: string;
		baseBranch?: string;
		title?: string;
		prompt?: string;
		issue?: { provider: 'github' | 'linear'; ref: string };
	}
) {
	return send<GhSession>(`${base(sandboxId)}/sessions`, 'POST', body);
}

export function patchSession(
	sandboxId: string,
	sid: string,
	body: { title?: string; archived?: boolean }
) {
	return send<GhSession>(`${base(sandboxId)}/sessions/${sid}`, 'PATCH', body);
}

export function deleteSession(sandboxId: string, sid: string, deleteBranch = false) {
	return send<void>(
		`${base(sandboxId)}/sessions/${sid}${qs({ deleteBranch: deleteBranch ? 1 : null })}`,
		'DELETE'
	);
}

export function listChats(sandboxId: string, sid: string) {
	return get<{ chats: GhChat[] }>(`${base(sandboxId)}/sessions/${sid}/chats`);
}

export function createChat(sandboxId: string, sid: string) {
	return send<GhChat>(`${base(sandboxId)}/sessions/${sid}/chats`, 'POST', {});
}

export function listRepos(sandboxId: string) {
	return get<{ repos: GhRepo[] }>(`${base(sandboxId)}/repos`);
}

export function addRepo(sandboxId: string, repoUrl: string) {
	return send<{ name: string }>(`${base(sandboxId)}/repos`, 'POST', { repoUrl });
}

export function changes(sandboxId: string, scope: Scope) {
	return get<GhChanges>(`${base(sandboxId)}/changes${qs(scoped(scope))}`);
}

export async function readFile(
	sandboxId: string,
	scope: Scope,
	path: string,
	ref?: string
): Promise<string> {
	const res = await get<{ content: string; truncated?: boolean }>(
		`${base(sandboxId)}/file${qs({ path, ...scoped(scope), ref })}`
	);
	if (!res.ok) throw new GhApiError(res.message, res.status);
	return res.data.content ?? '';
}

export function writeFile(sandboxId: string, scope: Scope, path: string, content: string) {
	return send<{ ok: boolean }>(`${base(sandboxId)}/file`, 'PUT', {
		...scoped(scope),
		path,
		content
	});
}

export function fsOp(
	sandboxId: string,
	op: 'mkdir' | 'rename' | 'delete',
	scope: Scope,
	body: { path: string; to?: string }
) {
	return send<{ ok: boolean }>(`${base(sandboxId)}/fs/${op}`, 'POST', {
		...scoped(scope),
		...body
	});
}

export async function listDir(
	sandboxId: string,
	directory: string,
	path: string
): Promise<GhFileNode[]> {
	const res = await get<GhFileNode[]>(
		`${base(sandboxId)}/opencode/file${qs({ directory, path: path || '.' })}`
	);
	return res.ok && Array.isArray(res.data) ? res.data : [];
}

export async function findFiles(
	sandboxId: string,
	directory: string,
	query: string,
	limit = 40
): Promise<string[]> {
	const res = await get<string[]>(
		`${base(sandboxId)}/opencode/find/file${qs({ directory, query, limit })}`
	);
	return res.ok && Array.isArray(res.data) ? res.data.filter((p) => !p.endsWith('/')) : [];
}

export type GitOutput = { ok: boolean; output: string };

export function gitCommit(
	sandboxId: string,
	scope: Scope,
	body: { message: string; files?: string[]; amend?: boolean }
) {
	return send<GitOutput>(`${base(sandboxId)}/git/commit`, 'POST', { ...scoped(scope), ...body });
}

export function gitPush(sandboxId: string, scope: Scope) {
	return send<GitOutput>(`${base(sandboxId)}/git/push`, 'POST', scoped(scope));
}

export function gitPull(sandboxId: string, scope: Scope) {
	return send<GitOutput>(`${base(sandboxId)}/git/pull`, 'POST', { ...scoped(scope), rebase: true });
}

export function gitFetch(sandboxId: string, scope: Scope) {
	return send<GitOutput>(`${base(sandboxId)}/git/fetch`, 'POST', scoped(scope));
}

export function createPr(
	sandboxId: string,
	scope: Scope,
	body: { title: string; body?: string; draft?: boolean; base?: string }
) {
	return send<{ url: string; number?: number }>(`${base(sandboxId)}/git/pr`, 'POST', {
		...scoped(scope),
		...body
	});
}

export function mergePr(sandboxId: string, sid: string) {
	return send<GitOutput>(`${base(sandboxId)}/sessions/${sid}/git/merge`, 'POST', {
		method: 'squash'
	});
}

export function listPorts(sandboxId: string, sid: string) {
	return get<{ ports: GhPort[] }>(`${base(sandboxId)}/sessions/${sid}/ports`);
}

export function listChecks(sandboxId: string, sid: string) {
	return get<GhChecks>(`${base(sandboxId)}/sessions/${sid}/checks`);
}

export function runScript(sandboxId: string, sid: string, action: 'start' | 'stop') {
	return send<{ ok: boolean }>(`${base(sandboxId)}/sessions/${sid}/run`, 'POST', { action });
}

export function gitIdentity(sandboxId: string) {
	return get<GhGitIdentity>(`${base(sandboxId)}/git/identity`);
}

export function connectInfo(sandboxId: string) {
	return get<GhConnect>(`${base(sandboxId)}/connect`);
}

export function previewToken(sandboxId: string, port: number) {
	return get<{ url: string }>(`${base(sandboxId)}/preview-token${qs({ port })}`);
}

export function listMembers(sandboxId: string) {
	return get<GhMembers>(`${base(sandboxId)}/members`);
}

export function addMember(
	sandboxId: string,
	body: { userId?: string; email?: string; role: 'viewer' | 'collaborator' }
) {
	return send<unknown>(`${base(sandboxId)}/members`, 'POST', body);
}

export function setMemberRole(sandboxId: string, userId: string, role: 'viewer' | 'collaborator') {
	return send<unknown>(`${base(sandboxId)}/members/${userId}`, 'PATCH', { role });
}

export function removeMember(sandboxId: string, userId: string) {
	return send<void>(`${base(sandboxId)}/members/${userId}`, 'DELETE');
}

export function listComments(sandboxId: string, sid: string, since?: string) {
	return get<{ comments: LiveComment[] }>(
		`${base(sandboxId)}/sessions/${sid}/comments${qs({ since })}`
	);
}

export function postComment(sandboxId: string, sid: string, chatId: string, body: string) {
	return send<LiveComment>(`${base(sandboxId)}/sessions/${sid}/comments`, 'POST', {
		chatId,
		body
	});
}

export function listAuthors(sandboxId: string, sid: string) {
	return get<{ authors: Record<string, PersonRef> }>(`${base(sandboxId)}/sessions/${sid}/authors`);
}

export function sandboxAction(sandboxId: string, action: 'start' | 'stop') {
	return send<unknown>(`${base(sandboxId)}/${action}`, 'POST');
}

export function deleteSandbox(sandboxId: string) {
	return send<unknown>(base(sandboxId), 'DELETE');
}

export interface OrgMemberLite {
	id: string;
	name: string;
	email: string | null;
	avatarUrl: string | null;
}

export async function listOrgMembers(organizationId: string): Promise<OrgMemberLite[]> {
	const res = await get<
		{
			user: {
				id: string;
				firstName?: string;
				lastName?: string;
				username?: string;
				email?: string;
				imageUrl?: string;
			};
		}[]
	>(`/apiv1/organizations/${organizationId}/members`);
	if (!res.ok || !Array.isArray(res.data)) return [];
	return res.data.map((m) => ({
		id: m.user.id,
		name:
			[m.user.firstName, m.user.lastName].filter(Boolean).join(' ') ||
			m.user.username ||
			m.user.email ||
			'Member',
		email: m.user.email ?? null,
		avatarUrl: m.user.imageUrl ?? null
	}));
}

export function retryApply(sandboxId: string) {
	return send<unknown>(`${base(sandboxId)}/apply/retry`, 'POST');
}

export function forkMachine(sandboxId: string, name?: string) {
	return send<{ id: string; name: string }>(
		`${base(sandboxId)}/fork`,
		'POST',
		name ? { name } : {}
	);
}

export function listLinks(sandboxId: string) {
	return get<{ links: GhProjectLink[] }>(`${base(sandboxId)}/links`);
}

export function attachProject(
	sandboxId: string,
	body: { projectId: string; environmentId?: string | null }
) {
	return send<GhProjectLink>(`${base(sandboxId)}/links`, 'POST', body);
}

export function detachProject(sandboxId: string, projectId: string) {
	return send<{ success: boolean }>(`${base(sandboxId)}/links/${projectId}`, 'DELETE');
}

export function previewDeploy(
	sandboxId: string,
	sid: string,
	body: { projectId: string; deploymentId?: string | null }
) {
	return send<GhPreviewResult>(`${base(sandboxId)}/sessions/${sid}/preview-deploy`, 'POST', body);
}

export function removePreview(sandboxId: string, sid: string) {
	return send<{ session: GhSession; removed: boolean }>(
		`${base(sandboxId)}/sessions/${sid}/preview-deploy`,
		'DELETE'
	);
}

export function listShareLinks(sandboxId: string) {
	return get<{ links: GhShareLink[] }>(`${base(sandboxId)}/share-links`);
}

export function createShareLink(
	sandboxId: string,
	body: { sessionId?: string | null; expiresInHours: number }
) {
	return send<GhShareLink & { token: string; url: string }>(
		`${base(sandboxId)}/share-links`,
		'POST',
		body
	);
}

export function revokeShareLink(sandboxId: string, linkId: string) {
	return send<GhShareLink>(`${base(sandboxId)}/share-links/${linkId}`, 'DELETE');
}

export type IssueList = { connected?: boolean; repo?: string | null; issues: GhIssue[] };

export function listIssues(
	sandboxId: string,
	provider: IssueProvider,
	params: { repo?: string | null; q?: string }
) {
	return get<IssueList>(
		`${base(sandboxId)}/issues${qs({ provider, repo: params.repo, q: params.q })}`
	);
}

type ProjectRow = {
	id: string;
	name: string;
	slug: string;
	members?: { user?: { id?: string } | null; role?: { name?: string } | null }[];
	deployments?: { id: string; name: string; displayName?: string | null }[];
};

export async function listEditableProjects(
	organizationId: string,
	who: { userId: string | null; orgRole: string | null; superAdmin: boolean }
): Promise<Maybe<GhOrchardProject[]>> {
	const res = await get<ProjectRow[]>(`/apiv1/projects${qs({ orgId: organizationId })}`);
	if (!res.ok) return res;
	const broad = who.superAdmin || who.orgRole === 'owner' || who.orgRole === 'admin';
	const rows = Array.isArray(res.data) ? res.data : [];
	return {
		ok: true,
		data: rows
			.filter(
				(p) =>
					broad ||
					(p.members ?? []).some(
						(m) =>
							m.user?.id === who.userId && (m.role?.name === 'admin' || m.role?.name === 'member')
					)
			)
			.map((p) => ({
				id: p.id,
				name: p.name,
				slug: p.slug,
				deployments: (p.deployments ?? []).map((d) => ({
					id: d.id,
					name: d.name,
					displayName: d.displayName ?? null
				}))
			}))
	};
}

export async function listEnvironments(projectId: string): Promise<GhEnvironment[]> {
	const res = await get<GhEnvironment[]>(`/apiv1/projects/${projectId}/environments`);
	return res.ok && Array.isArray(res.data) ? res.data : [];
}
