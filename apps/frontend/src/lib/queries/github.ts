import { browser } from '$app/environment';
import { queryClient } from '$lib/query';
import { apiFetch } from '$lib/stores/api';

export interface GitHubInstallationSummary {
	id: string;
	installationId: string;
	accountLogin: string;
	accountType: string;
	repositorySelection: string;
}

export interface GitHubStatus {
	linked: boolean;
	username: string | null;
	tokenExpired: boolean;
	installations: GitHubInstallationSummary[];
	appConfigured?: boolean;
}

export interface SearchedRepo {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	default_branch: string;
	clone_url: string;
	pushed_at: string | null;
	updated_at: string | null;
	installationId: string;
	accountLogin: string;
}

export interface RepoSearchResult {
	account: string;
	query: string;
	repositories: SearchedRepo[];
}

export class RepoSearchError extends Error {
	constructor(
		message: string,
		readonly code: string | null,
		readonly retryAfter: number | null
	) {
		super(message);
	}
}

const ACCOUNT_KEY = 'orchard:github-account';

export function githubStatusQueryOptions() {
	return {
		queryKey: ['github-status'],
		queryFn: async (): Promise<GitHubStatus> => {
			const res = await apiFetch('/apiv1/github/status');
			if (!res.ok) throw new Error("Couldn't check GitHub");
			return res.json();
		},
		staleTime: 60_000
	};
}

export function repoSearchQueryOptions(account: string, q: string) {
	const query = q.trim();
	return {
		queryKey: ['github-repo-search', account.toLowerCase(), query.toLowerCase()],
		queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<RepoSearchResult> => {
			const params = new URLSearchParams({ account, q: query });
			const res = await apiFetch(`/apiv1/github/repositories/search?${params}`, { signal });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new RepoSearchError(
					body?.message || "Couldn't search your repositories.",
					body?.code ?? null,
					typeof body?.retryAfter === 'number' ? body.retryAfter : null
				);
			}
			return res.json();
		},
		staleTime: 60_000,
		retry: false
	};
}

export function defaultAccount(installations: GitHubInstallationSummary[]): string | null {
	const remembered = browser ? localStorage.getItem(ACCOUNT_KEY) : null;
	const match = remembered
		? installations.find((i) => i.accountLogin.toLowerCase() === remembered.toLowerCase())
		: undefined;
	return (match ?? installations[0])?.accountLogin ?? null;
}

export function rememberAccount(login: string) {
	if (browser) localStorage.setItem(ACCOUNT_KEY, login);
}

export function installationSettingsUrl(inst: GitHubInstallationSummary): string {
	return inst.accountType === 'Organization'
		? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
		: `https://github.com/settings/installations/${inst.installationId}`;
}

export async function prefetchGitHubRepos() {
	const status = await queryClient.fetchQuery(githubStatusQueryOptions()).catch(() => null);
	if (!status?.linked || status.tokenExpired) return;
	const account = defaultAccount(status.installations ?? []);
	if (account) void queryClient.prefetchQuery(repoSearchQueryOptions(account, ''));
}

export async function createGithubApp(organization: string, returnTo: string): Promise<void> {
	const response = await apiFetch('/apiv1/setup/github-app/manifest', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ organization: organization.trim() || undefined, returnTo })
	});
	if (!response.ok) throw new Error("Couldn't create the GitHub App");

	const { postUrl, manifest, state } = await response.json();
	const form = document.createElement('form');
	form.method = 'POST';
	form.action = `${postUrl}?state=${encodeURIComponent(state)}`;
	const field = document.createElement('input');
	field.type = 'hidden';
	field.name = 'manifest';
	field.value = manifest;
	form.appendChild(field);
	document.body.appendChild(form);
	form.submit();
}
