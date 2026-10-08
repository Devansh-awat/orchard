import type { Sandbox, SandboxListResponse } from '$lib/types/sandbox';
import type {
	GhChanges,
	GhChecks,
	GhFileNode,
	GhMembers,
	GhSession
} from '$lib/components/greenhouse/types';

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

export const SEB = { id: 'user-seb', name: 'Seb', avatarUrl: null };
export const ALEX = { id: 'user-alex', name: 'Alex Rivera', avatarUrl: null };
export const SAM = { id: 'user-sam', name: 'Sam Okafor', avatarUrl: null };

const caps = {
	statusSource: 'watch' as const,
	persistence: 'volume' as const,
	homeMode: 'block' as const,
	tcpTunnel: 'native' as const,
	pty: 'native' as const,
	maxRunMs: null
};

function machine(over: Partial<Sandbox>): Sandbox {
	return {
		id: 'sbx-leaf',
		name: 'leaf-box',
		status: 'running',
		statusMessage: null,
		runner: 'kubernetes',
		desiredState: 'running',
		applying: false,
		applyError: null,
		diskObserved: '20Gi',
		myRole: 'owner',
		repoUrl: 'https://github.com/hackclub/orchard',
		sshIdentity: { id: 'id1', name: 'laptop' },
		setupScript: 'pnpm install',
		image: 'orchard/sandbox:latest',
		organizationId: 'org-1',
		owner: { id: SEB.id, username: 'seb', email: 'seb@example.com' },
		createdAt: iso(60 * 24 * 6),
		updatedAt: iso(3),
		lastActiveAt: iso(2),
		...over
	};
}

export function list(): SandboxListResponse {
	return {
		sandboxes: [
			machine({}),
			machine({
				id: 'sbx-docs',
				name: 'docs-preview',
				status: 'stopped',
				desiredState: 'stopped',
				runner: 'vercel',
				diskObserved: null,
				lastActiveAt: iso(60 * 26)
			}),
			machine({
				id: 'sbx-alex',
				name: 'alex-api',
				myRole: 'collaborator',
				owner: { id: ALEX.id, username: 'alex', email: 'alex@example.com' },
				lastActiveAt: iso(14)
			})
		],
		maxSandboxes: 5,
		runners: [
			{ id: 'kubernetes', label: 'Kubernetes', capabilities: caps, available: true, reason: null },
			{
				id: 'vercel',
				label: 'Vercel',
				capabilities: {
					...caps,
					statusSource: 'poll',
					persistence: 'snapshot',
					tcpTunnel: 'bridge',
					maxRunMs: 5 * 3_600_000
				},
				available: true,
				reason: null
			}
		],
		defaultRunner: 'kubernetes'
	};
}

const WT = '/persist/home/.worktrees/orchard';

function session(over: Partial<GhSession>): GhSession {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		sandboxId: 'sbx-leaf',
		title: 'Fix the login redirect loop',
		slug: 'fix-login',
		repo: 'orchard',
		branch: 'orchard/fix-login',
		baseBranch: 'main',
		baseCommit: 'a1b2c3d',
		worktreePath: `${WT}/fix-login`,
		agent: 'opencode',
		opencodeSessionId: 'ses_login',
		status: 'active',
		activity: 'working',
		diffstat: { files: 4, additions: 42, deletions: 7 },
		aheadBehind: { ahead: 2, behind: 0 },
		prUrl: null,
		prNumber: null,
		prState: null,
		previewDeploymentId: null,
		previewUrl: null,
		createdBy: SEB,
		createdAt: iso(40),
		updatedAt: iso(1),
		archivedAt: null,
		...over
	};
}

export function sessions(): GhSession[] {
	return [
		session({}),
		session({
			id: '22222222-2222-4222-8222-222222222222',
			title: 'Rate limit the preview token route',
			slug: 'rate-limit',
			branch: 'orchard/rate-limit',
			worktreePath: `${WT}/rate-limit`,
			opencodeSessionId: 'ses_rate',
			activity: 'needs_input',
			diffstat: { files: 2, additions: 18, deletions: 3 },
			createdBy: ALEX,
			updatedAt: iso(9)
		}),
		session({
			id: '33333333-3333-4333-8333-333333333333',
			title: 'Readme install section',
			slug: 'readme',
			branch: 'orchard/readme',
			worktreePath: `${WT}/readme`,
			opencodeSessionId: 'ses_readme',
			activity: 'done',
			diffstat: { files: 1, additions: 3, deletions: 0 },
			prUrl: 'https://github.com/hackclub/orchard/pull/412',
			prNumber: 412,
			prState: 'merged',
			updatedAt: iso(180)
		}),
		session({
			id: '44444444-4444-4444-8444-444444444444',
			title: 'Fix typos in the CLI guide',
			slug: 'typos',
			repo: 'docs',
			branch: 'orchard/typos',
			worktreePath: '/persist/home/.worktrees/docs/typos',
			opencodeSessionId: 'ses_typos',
			activity: 'idle',
			diffstat: null,
			updatedAt: iso(300)
		}),
		session({
			id: '55555555-5555-4555-8555-555555555555',
			title: 'Old spike on websockets',
			slug: 'ws-spike',
			branch: 'orchard/ws-spike',
			worktreePath: `${WT}/ws-spike`,
			status: 'archived',
			archivedAt: iso(60 * 30),
			activity: 'idle',
			diffstat: null,
			updatedAt: iso(60 * 30)
		})
	];
}

export const repos = [
	{ name: 'docs', branch: 'main', dirtyFiles: 0 },
	{ name: 'orchard', branch: 'main', dirtyFiles: 0 }
];

export const changes: GhChanges = {
	isRepo: true,
	branch: 'orchard/fix-login',
	ahead: 2,
	behind: 1,
	files: [
		{
			path: 'apps/server/src/auth/auth.controller.ts',
			status: 'M',
			staged: false,
			additions: 24,
			deletions: 6
		},
		{
			path: 'apps/server/src/auth/oauth-state.ts',
			status: 'M',
			staged: false,
			additions: 9,
			deletions: 1
		},
		{
			path: 'apps/server/test/auth-redirect.test.ts',
			status: '??',
			staged: false,
			additions: 31,
			deletions: 0
		},
		{
			path: 'apps/frontend/src/routes/login/+page.svelte',
			status: 'M',
			staged: false,
			additions: 2,
			deletions: 0
		}
	]
};

export function dir(path: string): GhFileNode[] {
	const node = (name: string, type: 'file' | 'directory', ignored = false): GhFileNode => {
		const p = path && path !== '.' ? `${path}/${name}` : name;
		return { name, path: p, absolute: `${WT}/fix-login/${p}`, type, ignored };
	};
	switch (path) {
		case '':
		case '.':
			return [
				node('.github', 'directory'),
				node('apps', 'directory'),
				node('infra', 'directory'),
				node('node_modules', 'directory', true),
				node('packages', 'directory'),
				node('AGENTS.md', 'file'),
				node('README.md', 'file'),
				node('package.json', 'file'),
				node('pnpm-lock.yaml', 'file')
			];
		case 'apps':
			return [node('cli', 'directory'), node('frontend', 'directory'), node('server', 'directory')];
		case 'apps/server':
			return [
				node('prisma', 'directory'),
				node('src', 'directory'),
				node('test', 'directory'),
				node('package.json', 'file')
			];
		case 'apps/server/src':
			return [node('auth', 'directory'), node('sandboxes', 'directory'), node('main.ts', 'file')];
		case 'apps/server/src/auth':
			return [
				node('auth.controller.ts', 'file'),
				node('auth.module.ts', 'file'),
				node('oauth-state.ts', 'file')
			];
		default:
			return [];
	}
}

export const AUTH_HEAD = `import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('callback')
  async callback(@Query('code') code: string, @Res() res: Response) {
    const token = await this.auth.exchange(code);
    res.cookie('session', token, { sameSite: 'lax' });
    return res.redirect('/');
  }
}
`;

export const AUTH_NOW = `import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { readReturnTo } from './oauth-state';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response
  ) {
    const token = await this.auth.exchange(code);
    res.cookie('session', token, {
      domain: process.env.COOKIE_DOMAIN,
      sameSite: 'lax',
      secure: true
    });
    return res.redirect(readReturnTo(state) ?? '/');
  }
}
`;

export const checks: GhChecks = {
	pr: {
		number: 418,
		title: 'Fix the login redirect loop',
		url: 'https://github.com/hackclub/orchard/pull/418',
		state: 'open',
		draft: false
	},
	checks: [
		{ name: 'lint', status: 'completed', conclusion: 'success', url: null },
		{
			name: 'server / test',
			status: 'completed',
			conclusion: 'failure',
			url: null,
			logExcerpt:
				'FAIL test/auth-redirect.test.ts\n  ✕ keeps returnTo through the oauth state (12 ms)\n    Expected: "/projects"\n    Received: "/"'
		},
		{ name: 'frontend / build', status: 'in_progress', conclusion: null, url: null },
		{ name: 'chart', status: 'completed', conclusion: 'skipped', url: null }
	]
};

export const members: GhMembers = {
	owner: { id: SEB.id, name: 'Seb', email: 'seb@example.com', avatarUrl: null },
	members: [
		{
			user: { id: ALEX.id, name: ALEX.name, email: 'alex@example.com', avatarUrl: null },
			role: 'collaborator',
			createdAt: iso(600)
		},
		{
			user: { id: SAM.id, name: SAM.name, email: 'sam@example.com', avatarUrl: null },
			role: 'viewer',
			createdAt: iso(500)
		}
	],
	myRole: 'owner'
};
