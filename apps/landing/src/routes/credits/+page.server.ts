import { env } from '$env/dynamic/private';
import credits from '$lib/credits.generated.json';
import type { PageServerLoad } from './$types';

type Person = { login: string; name: string; avatar: string; commits: number };
type GitHubContributor = { login: string; type: string; avatar_url: string; contributions: number };

const REPO = 'hackclub/orchard';
const FRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

const baked: Person[] = credits.people.map((person) => ({
	login: person.login,
	name: person.name,
	avatar: `https://github.com/${person.login}.png?size=112`,
	commits: person.commits ?? 0
}));

let cache: { until: number; people: Person[] } | null = null;

async function github<T>(fetch: typeof globalThis.fetch, path: string): Promise<T> {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'user-agent': 'orchard-credits'
	};
	if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
	const response = await fetch(`https://api.github.com${path}`, {
		headers,
		signal: AbortSignal.timeout(4000)
	});
	if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
	return (await response.json()) as T;
}

async function displayName(fetch: typeof globalThis.fetch, login: string) {
	const known = baked.find((person) => person.login.toLowerCase() === login.toLowerCase());
	if (known) return known.name;
	try {
		const user = await github<{ name: string | null }>(fetch, `/users/${login}`);
		return user.name || login;
	} catch {
		return login;
	}
}

async function contributors(fetch: typeof globalThis.fetch): Promise<Person[]> {
	if (cache && cache.until > Date.now()) return cache.people;
	try {
		const listed = await github<GitHubContributor[]>(
			fetch,
			`/repos/${REPO}/contributors?per_page=100`
		);
		const live = await Promise.all(
			listed
				.filter((person) => person.type === 'User')
				.map(async (person) => ({
					login: person.login,
					name: await displayName(fetch, person.login),
					avatar: `${person.avatar_url}${person.avatar_url.includes('?') ? '&' : '?'}s=112`,
					commits: person.contributions
				}))
		);
		const seen = new Set(live.map((person) => person.login.toLowerCase()));
		const people = [
			...live,
			...baked.filter((person) => !seen.has(person.login.toLowerCase()))
		].sort((a, b) => b.commits - a.commits);
		cache = { until: Date.now() + FRESH_MS, people };
	} catch {
		cache = { until: Date.now() + RETRY_MS, people: baked };
	}
	return cache.people;
}

export const load: PageServerLoad = async ({ fetch, setHeaders }) => {
	setHeaders({ 'cache-control': 'public, max-age=300' });
	return { people: await contributors(fetch) };
};
