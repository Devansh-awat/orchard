import type { Sandbox, SandboxListResponse } from '../../../lib/types/sandbox';
import type { GhChanges, GhChecks, GhFileNode, GhMembers, GhSession } from '../types';

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
  maxRunMs: null,
  fork: true,
  previews: 'proxy' as const
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
    previewStatus: null,
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

export const repos: {
  name: string;
  branch: string;
  dirtyFiles: number;
  github: { owner: string; name: string } | null;
  icon: string | null;
}[] = [
  { name: 'docs', branch: 'main', dirtyFiles: 0, github: null, icon: 'lucide:book' },
  {
    name: 'orchard',
    branch: 'main',
    dirtyFiles: 0,
    github: { owner: 'hackclub', name: 'orchard' },
    icon: 'github'
  }
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

export const projects = [
  { id: 'prj-web', name: 'orchard-web', slug: 'orchard-web' },
  { id: 'prj-api', name: 'orchard-api', slug: 'orchard-api' },
  { id: 'prj-docs', name: 'docs', slug: 'docs' }
];

export const projectRows = projects.map((p, i) => ({
  ...p,
  members: [{ user: { id: SEB.id }, role: { name: i === 2 ? 'viewer' : 'admin' } }],
  deployments:
    p.id === 'prj-web'
      ? [
          { id: 'dep-web', name: 'web', displayName: 'Web' },
          { id: 'dep-worker', name: 'worker', displayName: 'Worker' }
        ]
      : [{ id: `dep-${p.slug}`, name: p.slug, displayName: null }]
}));

export const environments = [
  { id: 'env-prod', name: 'production', slug: 'production', isDefault: true },
  { id: 'env-staging', name: 'staging', slug: 'staging', isDefault: false }
];

export const projectLinks = [
  {
    id: 'lnk-1',
    projectId: 'prj-api',
    project: { id: 'prj-api', name: 'orchard-api', slug: 'orchard-api' },
    environment: { id: 'env-staging', name: 'staging', slug: 'staging' },
    envFile: '~/.config/orchard/env/orchard-api.env',
    createdBy: SEB,
    createdAt: iso(600)
  }
];

export const shareLinks = [
  {
    id: 'shr-1',
    sandboxId: 'sbx-leaf',
    sessionId: '11111111-1111-4111-8111-111111111111',
    session: { id: '11111111-1111-4111-8111-111111111111', title: 'Fix the login redirect loop' },
    createdBy: SEB,
    state: 'active' as const,
    expiresAt: new Date(NOW + 6 * 86_400_000).toISOString(),
    revokedAt: null,
    lastUsedAt: iso(35),
    createdAt: iso(60 * 24)
  },
  {
    id: 'shr-2',
    sandboxId: 'sbx-leaf',
    sessionId: null,
    session: null,
    createdBy: SEB,
    state: 'revoked' as const,
    expiresAt: new Date(NOW + 20 * 86_400_000).toISOString(),
    revokedAt: iso(120),
    lastUsedAt: null,
    createdAt: iso(60 * 30)
  }
];

const issue = (
  provider: 'github' | 'linear',
  ref: string,
  title: string,
  labels: string[] = []
) => ({
  provider,
  ref,
  title,
  url: null,
  labels,
  state: provider === 'linear' ? 'In Progress' : 'open',
  updatedAt: iso(90)
});

export const githubIssues = [
  issue(
    'github',
    'hackclub/orchard#431',
    'Login bounces back to the login page on app.orchard.my',
    ['bug']
  ),
  issue('github', 'hackclub/orchard#428', 'Preview tokens are not rate limited'),
  issue('github', 'hackclub/orchard#419', 'CLI guide has typos in the sandbox section', ['docs']),
  issue('github', 'hackclub/orchard#402', 'Show build cache hits in the build log')
];

export const linearIssues = [
  issue('linear', 'ORC-212', 'Greenhouse: attach project variables to a machine'),
  issue('linear', 'ORC-207', 'Slack kickoff should reply in the thread'),
  issue('linear', 'ORC-198', 'Fork machines from a snapshot')
];

export const shareView = {
  link: {
    id: 'shr-1',
    sessionId: null,
    expiresAt: new Date(NOW + 6 * 86_400_000).toISOString(),
    createdBy: { id: SEB.id, name: 'Seb', avatarUrl: null }
  },
  sandbox: { id: 'sbx-leaf', name: 'leaf-box', status: 'running' },
  sessions: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Fix the login redirect loop',
      repo: 'orchard',
      branch: 'orchard/fix-login',
      baseBranch: 'main',
      status: 'active' as const,
      prUrl: null,
      createdAt: iso(40)
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Rate limit the preview token route',
      repo: 'orchard',
      branch: 'orchard/rate-limit',
      baseBranch: 'main',
      status: 'active' as const,
      prUrl: null,
      createdAt: iso(60)
    }
  ]
};

export const shareTranscript = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  chatId: 'ses_login',
  title: 'Fix the login redirect loop',
  messages: [
    {
      id: 'msg_u1',
      role: 'user' as const,
      text: 'Logging in on app.orchard.my bounces me back to the login page forever. Can you find out why and fix it?',
      truncated: false,
      createdAt: iso(40),
      author: { id: SEB.id, name: 'Seb', avatarUrl: null }
    },
    {
      id: 'msg_a1',
      role: 'assistant' as const,
      text: 'The redirect loop comes from the session cookie being scoped to `app.orchard.my` while the login callback lands on `orchard.my`. I scoped it to the parent domain and added a regression test.\n\nTwo things changed:\n\n1. `auth.controller.ts` now sets `domain` from `COOKIE_DOMAIN` instead of the request host\n2. the callback keeps `returnTo` through the OAuth state, so you land where you started',
      truncated: false,
      createdAt: iso(38),
      author: null
    },
    {
      id: 'msg_u3',
      role: 'user' as const,
      text: 'Nice. Now make the callback keep returnTo.',
      truncated: false,
      createdAt: iso(20),
      author: { id: ALEX.id, name: ALEX.name, avatarUrl: null }
    },
    {
      id: 'msg_a3',
      role: 'assistant' as const,
      text: 'Done. `readReturnTo(state)` validates the path is same-origin before redirecting, and the new test covers a `returnTo` of `/projects`.',
      truncated: false,
      createdAt: iso(18),
      author: null
    }
  ]
};

export const shareDiff = `diff --git a/apps/server/src/auth/auth.controller.ts b/apps/server/src/auth/auth.controller.ts
index 3f1a2b4..9c8d7e6 100644
--- a/apps/server/src/auth/auth.controller.ts
+++ b/apps/server/src/auth/auth.controller.ts
@@ -1,15 +1,24 @@
 import { Controller, Get, Query, Res } from '@nestjs/common';
 import type { Response } from 'express';
 import { AuthService } from './auth.service';
+import { readReturnTo } from './oauth-state';
 
 @Controller('auth')
 export class AuthController {
   constructor(private readonly auth: AuthService) {}
 
   @Get('callback')
-  async callback(@Query('code') code: string, @Res() res: Response) {
+  async callback(
+    @Query('code') code: string,
+    @Query('state') state: string,
+    @Res() res: Response
+  ) {
     const token = await this.auth.exchange(code);
-    res.cookie('session', token, { sameSite: 'lax' });
-    return res.redirect('/');
+    res.cookie('session', token, {
+      domain: process.env.COOKIE_DOMAIN,
+      sameSite: 'lax',
+      secure: true
+    });
+    return res.redirect(readReturnTo(state) ?? '/');
   }
 }
`;
