import { apiFetch } from '$lib/stores/api';

export type GitProviderKind = 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'generic';

export interface GitConnection {
	id: string;
	provider: GitProviderKind;
	name: string;
	baseUrl: string;
	host: string;
	username: string | null;
	canList: boolean;
	webhookPath: string;
	oauth: boolean;
	dependents: number;
	createdAt: string;
	updatedAt: string;
}

export interface GitRepo {
	id: string;
	fullName: string;
	url: string;
	defaultBranch: string | null;
	private: boolean;
}

export interface GitBranch {
	name: string;
	sha: string | null;
}

export const PROVIDERS: {
	kind: GitProviderKind;
	label: string;
	baseUrl: string;
	tokenHint: string;
	needsUsername: boolean;
	webhookHint: string;
}[] = [
	{
		kind: 'gitlab',
		label: 'GitLab',
		baseUrl: 'https://gitlab.com',
		tokenHint: 'Personal or project access token with read_api and read_repository',
		needsUsername: false,
		webhookHint: 'Secret token field, push events'
	},
	{
		kind: 'gitea',
		label: 'Gitea, Forgejo or Codeberg',
		baseUrl: 'https://codeberg.org',
		tokenHint: 'Access token with repository read',
		needsUsername: false,
		webhookHint: 'Gitea webhook, secret field, push events'
	},
	{
		kind: 'github',
		label: 'GitHub with a token',
		baseUrl: 'https://github.com',
		tokenHint: 'Fine-grained token with contents read. Use the GitHub App instead when you can.',
		needsUsername: false,
		webhookHint: 'Secret field, content type application/json, push events'
	},
	{
		kind: 'bitbucket',
		label: 'Bitbucket Cloud',
		baseUrl: 'https://bitbucket.org',
		tokenHint: 'App password with repository read',
		needsUsername: true,
		webhookHint: 'Secret field, repository push trigger'
	},
	{
		kind: 'generic',
		label: 'Any git host',
		baseUrl: '',
		tokenHint: 'Password or token used to clone over https',
		needsUsername: true,
		webhookHint: 'Send a GitHub-shaped push payload signed with X-Hub-Signature-256'
	}
];

export function providerLabel(kind: GitProviderKind): string {
	return PROVIDERS.find((p) => p.kind === kind)?.label ?? kind;
}

async function readError(res: Response, fallback: string): Promise<never> {
	const data = await res.json().catch(() => ({}));
	throw new Error((data as { message?: string }).message || fallback);
}

export async function fetchGitConnections(): Promise<GitConnection[]> {
	const res = await apiFetch(`/apiv1/users/me/git-connections`);
	if (!res.ok) return readError(res, 'Could not load git providers');
	return res.json();
}

export async function createGitConnection(input: {
	provider: GitProviderKind;
	name: string;
	baseUrl: string;
	username: string | null;
	token: string;
}): Promise<GitConnection> {
	const res = await apiFetch(`/apiv1/users/me/git-connections`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input)
	});
	if (!res.ok) return readError(res, 'Could not add the provider');
	return res.json();
}

export async function deleteGitConnection(id: string): Promise<void> {
	const res = await apiFetch(`/apiv1/users/me/git-connections/${id}`, {
		method: 'DELETE'
	});
	if (!res.ok) return readError(res, 'Could not remove the provider');
}

export async function fetchWebhookSecret(id: string): Promise<string> {
	const res = await apiFetch(`/apiv1/users/me/git-connections/${id}/webhook-secret`);
	if (!res.ok) return readError(res, 'Could not load the secret');
	return ((await res.json()) as { secret: string }).secret;
}

export async function fetchGitRepos(id: string): Promise<GitRepo[]> {
	const res = await apiFetch(`/apiv1/users/me/git-connections/${id}/repositories`);
	if (!res.ok) return readError(res, 'Could not list repositories');
	return res.json();
}

export async function fetchGitBranches(id: string, repo: string): Promise<GitBranch[]> {
	const res = await apiFetch(
		`/apiv1/users/me/git-connections/${id}/branches?repo=${encodeURIComponent(repo)}`
	);
	if (!res.ok) return readError(res, 'Could not list branches');
	return res.json();
}

export async function detectGitRepo(
	id: string,
	repo: string,
	branch: string
): Promise<Record<string, unknown>> {
	const res = await apiFetch(
		`/apiv1/users/me/git-connections/${id}/detect?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`
	);
	if (!res.ok) return readError(res, 'Could not inspect the repository');
	return res.json();
}

export function repoPathOn(connection: GitConnection, repoUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repoUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.host !== connection.host) return null;
	const base = new URL(connection.baseUrl).pathname.replace(/\/+$/, '');
	const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
	if (base && !path.startsWith(`${base}/`)) return null;
	const rel = (base ? path.slice(base.length) : path).replace(/^\/+/, '');
	return rel.includes('/') ? rel : null;
}

export type OauthAvailability = Record<'gitlab' | 'bitbucket', { baseUrl: string } | null>;

export async function fetchOauthAvailability(): Promise<OauthAvailability> {
	const res = await apiFetch('/apiv1/users/me/git-connections/oauth');
	if (!res.ok) return { gitlab: null, bitbucket: null };
	return res.json();
}

export function oauthStartUrl(provider: 'gitlab' | 'bitbucket'): string {
	return `/apiv1/git/oauth/${provider}/start`;
}
