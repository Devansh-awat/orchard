import type { MockContext } from '../plugin.ts';
import { notFound, type Router } from '../router.ts';

type Profile = {
	framework: string | null;
	buildType: 'dockerfile' | 'railpack';
	ports: number[];
	env: { key: string; value: string }[];
	dockerfiles: string[];
	stages: string[];
	apps?: {
		dir: string;
		framework: string;
		port: number;
		installCommand: string | null;
		buildCommand: string | null;
		startCommand: string | null;
		outputDirectory: string | null;
		packageName: string | null;
	}[];
	workspace?: string;
};

type Repo = {
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
	branches: string[];
	updated: number;
	profile: Profile;
};

const app = (
	dir: string,
	framework: string,
	port: number,
	build: string | null,
	start: string | null,
	output: string | null = null
) => ({
	dir,
	framework,
	port,
	installCommand: 'pnpm install',
	buildCommand: build,
	startCommand: start,
	outputDirectory: output,
	packageName: dir ? (dir.split('/').pop() ?? null) : null
});

const NEXT: Profile = {
	framework: 'nextjs',
	buildType: 'railpack',
	ports: [3000],
	env: [{ key: 'NEXT_TELEMETRY_DISABLED', value: '1' }],
	dockerfiles: [],
	stages: [],
	apps: [app('', 'nextjs', 3000, 'pnpm build', 'pnpm start')]
};

const REPOS: Repo[] = [
	{
		owner: 'hackclub',
		name: 'site',
		private: false,
		defaultBranch: 'main',
		branches: ['main', 'preview/arcade', 'fix/footer-links', 'renovate/next-15'],
		updated: 1,
		profile: NEXT
	},
	{
		owner: 'hackclub',
		name: 'arcade-leaderboard',
		private: false,
		defaultBranch: 'main',
		branches: ['main', 'season-2'],
		updated: 3,
		profile: {
			framework: 'python',
			buildType: 'railpack',
			ports: [8000],
			env: [{ key: 'DATABASE_URL', value: '' }],
			dockerfiles: [],
			stages: [],
			apps: [app('', 'python', 8000, null, 'uvicorn app.main:app --host 0.0.0.0')]
		}
	},
	{
		owner: 'hackclub',
		name: 'slack-bots',
		private: true,
		defaultBranch: 'main',
		branches: ['main', 'orpheus-v2'],
		updated: 5,
		profile: {
			framework: null,
			buildType: 'dockerfile',
			ports: [3000],
			env: [
				{ key: 'SLACK_BOT_TOKEN', value: '' },
				{ key: 'SLACK_SIGNING_SECRET', value: '' }
			],
			dockerfiles: ['Dockerfile', 'bots/orpheus/Dockerfile'],
			stages: ['deps', 'build', 'runtime'],
			apps: []
		}
	},
	{
		owner: 'hackclub',
		name: 'mercury',
		private: true,
		defaultBranch: 'main',
		branches: ['main', 'develop'],
		updated: 9,
		profile: {
			framework: 'sveltekit',
			buildType: 'railpack',
			ports: [3000],
			env: [{ key: 'RESEND_API_KEY', value: '' }],
			dockerfiles: [],
			stages: [],
			workspace: 'pnpm',
			apps: [
				app('apps/web', 'sveltekit', 3000, 'pnpm build', 'node build'),
				app('apps/api', 'node', 8080, 'pnpm build', 'node dist/index.js'),
				app('apps/worker', 'node', 9000, 'pnpm build', 'node dist/worker.js')
			]
		}
	},
	{
		owner: 'alfd',
		name: 'portfolio',
		private: false,
		defaultBranch: 'main',
		branches: ['main', 'redesign'],
		updated: 2,
		profile: {
			framework: 'astro',
			buildType: 'railpack',
			ports: [80],
			env: [],
			dockerfiles: [],
			stages: [],
			apps: [app('', 'astro', 80, 'pnpm build', null, 'dist')]
		}
	},
	{
		owner: 'alfd',
		name: 'link-shortener',
		private: false,
		defaultBranch: 'main',
		branches: ['main'],
		updated: 14,
		profile: {
			framework: 'go',
			buildType: 'railpack',
			ports: [8080],
			env: [{ key: 'REDIS_URL', value: '' }],
			dockerfiles: ['Dockerfile'],
			stages: ['build', 'final'],
			apps: [app('', 'go', 8080, 'go build -o bin/app', './bin/app')]
		}
	},
	{
		owner: 'alfd',
		name: 'homelab-dashboard',
		private: true,
		defaultBranch: 'master',
		branches: ['master', 'feature/widgets'],
		updated: 30,
		profile: {
			framework: 'rust',
			buildType: 'dockerfile',
			ports: [4000],
			env: [{ key: 'RUST_LOG', value: 'info' }],
			dockerfiles: ['Dockerfile'],
			stages: ['chef', 'planner', 'builder', 'runtime'],
			apps: []
		}
	},
	{
		owner: 'orpheus-labs',
		name: 'ysws-api',
		private: true,
		defaultBranch: 'main',
		branches: ['main', 'staging'],
		updated: 4,
		profile: {
			framework: 'node',
			buildType: 'railpack',
			ports: [3001],
			env: [
				{ key: 'AIRTABLE_TOKEN', value: '' },
				{ key: 'NODE_ENV', value: 'production' }
			],
			dockerfiles: [],
			stages: [],
			apps: [app('', 'node', 3001, 'pnpm build', 'pnpm start')]
		}
	},
	{
		owner: 'orpheus-labs',
		name: 'docs',
		private: false,
		defaultBranch: 'main',
		branches: ['main'],
		updated: 21,
		profile: {
			framework: 'static',
			buildType: 'railpack',
			ports: [80],
			env: [],
			dockerfiles: [],
			stages: [],
			apps: [app('', 'static', 80, null, null, 'public')]
		}
	}
];

const DAY = 86_400_000;
const fullName = (r: Repo) => `${r.owner}/${r.name}`;
const find = (owner: string, name: string) =>
	REPOS.find((r) => r.owner === owner && r.name === name);

function githubRow(r: Repo, i: number) {
	return {
		id: 9000 + i,
		name: r.name,
		full_name: fullName(r),
		owner: { login: r.owner, avatar_url: `https://github.com/${r.owner}.png?size=64` },
		clone_url: `https://github.com/${fullName(r)}.git`,
		html_url: `https://github.com/${fullName(r)}`,
		default_branch: r.defaultBranch,
		private: r.private,
		updated_at: new Date(Date.now() - r.updated * DAY).toISOString()
	};
}

function detection(r: Repo) {
	const p = r.profile;
	return {
		buildType: p.buildType,
		dockerfilePath: p.buildType === 'dockerfile' ? (p.dockerfiles[0] ?? 'Dockerfile') : null,
		dockerfiles: p.dockerfiles,
		stages: p.stages,
		ports: p.ports,
		env: p.env,
		framework: p.framework,
		apps: p.apps ?? [],
		workspace: { isWorkspace: !!p.workspace, packageManager: p.workspace ?? 'pnpm' },
		score: null,
		rootDirectory: p.apps && p.apps.length > 1 ? p.apps[0].dir : ''
	};
}

type Connection = {
	id: string;
	provider: 'gitlab' | 'gitea' | 'bitbucket' | 'generic';
	name: string;
	baseUrl: string;
	host: string;
	username: string | null;
	repos: Repo[];
};

const CONNECTIONS: Connection[] = [
	{
		id: 'gc-gitlab',
		provider: 'gitlab',
		name: 'GitLab',
		baseUrl: 'https://gitlab.com',
		host: 'gitlab.com',
		username: 'alfd',
		repos: [
			{ ...REPOS[4], owner: 'alfd', name: 'thesis-site' },
			{ ...REPOS[7], owner: 'hackclub-eu', name: 'events-api' }
		]
	},
	{
		id: 'gc-codeberg',
		provider: 'gitea',
		name: 'Codeberg',
		baseUrl: 'https://codeberg.org',
		host: 'codeberg.org',
		username: 'alfd',
		repos: [{ ...REPOS[5], owner: 'alfd', name: 'tiny-paste' }]
	}
];

function connectionRow(c: Connection) {
	const now = new Date().toISOString();
	return {
		id: c.id,
		provider: c.provider,
		name: c.name,
		baseUrl: c.baseUrl,
		host: c.host,
		username: c.username,
		canList: true,
		webhookPath: `/apiv1/git/webhooks/${c.id}`,
		oauth: c.provider === 'gitlab',
		dependents: 0,
		createdAt: now,
		updatedAt: now
	};
}

const INSTALLATIONS = [
	{ login: 'hackclub', type: 'Organization', selection: 'all' },
	{ login: 'orpheus-labs', type: 'Organization', selection: 'selected' },
	{ login: 'alfd', type: 'User', selection: 'all' }
].map((x, i) => ({
	id: `inst-${x.login}`,
	installationId: String(48_120_000 + i),
	accountLogin: x.login,
	accountType: x.type,
	repositorySelection: x.selection
}));

export function gitRoutes(r: Router, _ctx: MockContext) {
	r.get('/github/status', () => ({
		linked: true,
		appConfigured: true,
		username: 'alfd',
		tokenExpired: false,
		installations: INSTALLATIONS
	}));

	r.get('/github/app/installations', () => INSTALLATIONS);

	r.get('/github/app/install', () => ({
		url: 'https://github.com/apps/orchard-mock/installations/new'
	}));

	r.get('/github/repositories', () => ({
		source: 'app',
		installations: INSTALLATIONS,
		repositories: REPOS.toSorted((a, b) => a.updated - b.updated).map((x) =>
			githubRow(x, REPOS.indexOf(x))
		)
	}));

	r.get('/github/repositories/:owner/:repo/branches', ({ params }) => {
		const repo = find(params.owner, params.repo);
		if (!repo) return [{ name: 'main', protected: false }];
		return repo.branches.map((name) => ({ name, protected: name === repo.defaultBranch }));
	});

	r.get('/github/repositories/:owner/:repo/detect', ({ params }) => {
		const repo = find(params.owner, params.repo);
		return repo
			? detection(repo)
			: detection({ ...REPOS[0], owner: params.owner, name: params.repo });
	});

	r.get('/github/repositories/:owner/:repo/dockerfiles', ({ params }) => {
		const repo = find(params.owner, params.repo);
		return repo?.profile.dockerfiles.length ? repo.profile.dockerfiles : ['Dockerfile'];
	});

	r.get('/github/repositories/:owner/:repo/dockerfile-info', ({ params }) => {
		const repo = find(params.owner, params.repo);
		return {
			exposedPorts: repo?.profile.ports ?? [3000],
			envVars: repo?.profile.env ?? [],
			stages: repo?.profile.stages ?? []
		};
	});

	r.get('/users/me/git-connections', () => CONNECTIONS.map(connectionRow));
	r.get('/users/me/git-connections/oauth', () => ({
		gitlab: { baseUrl: 'https://gitlab.com' },
		bitbucket: null
	}));

	r.get('/users/me/git-connections/:id/repositories', ({ params }) => {
		const c = CONNECTIONS.find((x) => x.id === params.id);
		if (!c) return notFound('Connection not found');
		return c.repos.map((x, i) => ({
			id: `${c.id}-${i}`,
			fullName: fullName(x),
			url: `${c.baseUrl}/${fullName(x)}.git`,
			defaultBranch: x.defaultBranch,
			private: x.private
		}));
	});

	r.get('/users/me/git-connections/:id/branches', ({ params, query }) => {
		const c = CONNECTIONS.find((x) => x.id === params.id);
		const repo = c?.repos.find((x) => fullName(x) === query.get('repo'));
		return (repo?.branches ?? ['main']).map((name) => ({ name, sha: null }));
	});

	r.get('/users/me/git-connections/:id/detect', ({ params, query }) => {
		const c = CONNECTIONS.find((x) => x.id === params.id);
		const repo = c?.repos.find((x) => fullName(x) === query.get('repo'));
		return detection(repo ?? REPOS[0]);
	});
}
