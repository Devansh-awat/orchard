import { z } from 'zod';
import type { RouteAttachment } from '../types';

const sandboxStatus = z.enum([
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'deleting',
  'error'
]);

const sandboxRunnerId = z.enum(['kubernetes', 'vercel']);

const sandboxDesiredState = z.enum(['running', 'stopped', 'deleted']);

const sandboxRunner = z.object({
  id: sandboxRunnerId,
  label: z.string(),
  capabilities: z.object({
    statusSource: z.enum(['watch', 'poll']),
    persistence: z.enum(['volume', 'snapshot']),
    homeMode: z.enum(['block', 'filesystem', 'none']),
    tcpTunnel: z.enum(['native', 'bridge', 'none']),
    pty: z.enum(['native', 'none']),
    execStdin: z.boolean(),
    maxRunMs: z.number().int().nullable(),
    diskSizeConfigurable: z.boolean(),
    fork: z.boolean(),
    previews: z.enum(['proxy', 'public', 'none'])
  }),
  available: z.boolean().describe('Whether new sandboxes can be created on this runner'),
  reason: z.string().nullable().describe('Why the runner is unavailable, when it is')
});

const sandboxName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'lowercase DNS label');

const sandbox = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: sandboxStatus,
  statusMessage: z.string().nullable(),
  runner: sandboxRunnerId,
  desiredState: sandboxDesiredState.describe('What the sandbox was last asked to be'),
  applying: z.boolean().describe('Whether a change is still being applied to the runner'),
  applyError: z
    .string()
    .nullable()
    .describe('The last change that failed to apply, until a later attempt succeeds'),
  diskObserved: z
    .string()
    .nullable()
    .describe('Disk capacity the runner actually provisioned, when it reports one'),
  repoUrl: z.string().nullable(),
  sshIdentity: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
  setupScript: z.string().nullable(),
  image: z.string(),
  organizationId: z.string().uuid().nullable(),
  owner: z
    .object({
      id: z.string().uuid(),
      username: z.string().nullable(),
      email: z.string().nullable()
    })
    .nullable()
    .describe('Populated when listing an organization as an owner or admin'),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActiveAt: z.string().nullable(),
  myRole: z
    .enum(['owner', 'collaborator', 'viewer', 'admin'])
    .optional()
    .describe(
      'owner is the host, collaborator a guest, viewer a read-only guest, admin an org admin'
    )
});

const sessionId = z.string().uuid();

const memberRole = z.enum(['viewer', 'collaborator']);

const memberUser = z.object({
  id: z.string().uuid(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  email: z.string()
});

const sessionUser = z.object({
  id: z.string().uuid(),
  name: z.string(),
  avatarUrl: z.string().nullable()
});

const sandboxMember = z.object({
  user: memberUser,
  role: memberRole,
  invitedBy: sessionUser.nullable(),
  createdAt: z.string()
});

const sessionComment = z.object({
  id: z.string().uuid(),
  sessionId,
  chatId: z.string(),
  author: sessionUser,
  body: z.string(),
  createdAt: z.string()
});

const previewStatus = z.enum(['building', 'deploying', 'ready', 'failed', 'stopped', 'gone']);

const sandboxSession = z.object({
  id: sessionId,
  sandboxId: z.string().uuid(),
  title: z.string(),
  slug: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable().describe('orchard/<slug>'),
  baseBranch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  worktreePath: z.string().nullable(),
  agent: z.literal('opencode'),
  opencodeSessionId: z.string().nullable().describe('The primary opencode chat'),
  status: z.enum(['active', 'archived']),
  activity: z
    .enum(['idle', 'working', 'needs_input', 'done'])
    .describe('Best effort from opencode /session/status while the box runs'),
  diffstat: z
    .object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() })
    .nullable()
    .describe('Changes against the base branch, including uncommitted work'),
  aheadBehind: z.object({ ahead: z.number().int(), behind: z.number().int() }).nullable(),
  prUrl: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prState: z.enum(['open', 'merged', 'closed']).nullable(),
  previewDeploymentId: z.string().uuid().nullable(),
  previewUrl: z
    .string()
    .nullable()
    .describe('Server-computed from the preview ingress; never build it from the host'),
  previewStatus: previewStatus
    .nullable()
    .describe('Build and rollout state of the preview deployment, null without a preview'),
  createdBy: sessionUser.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  preparing: z
    .boolean()
    .describe('The worktree and agent session are still being set up in the background'),
  prepareError: z
    .string()
    .nullable()
    .describe('Why background setup failed; the session never became usable')
});

const sessionScripts = z.object({
  setup: z.string().nullable(),
  run: z.string().nullable(),
  ports: z.array(z.number().int()),
  setupState: z.enum(['none', 'running', 'done', 'failed']),
  running: z.boolean().describe('Whether the run script is alive in its tmux window')
});

const fsRequest = z.object({
  session: sessionId.optional(),
  repo: z.string().optional(),
  path: z.string().max(1024).describe('Relative to the session worktree or repo'),
  to: z.string().max(1024).optional()
});

const workspaceChanges = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number().int().nullable(),
      deletions: z.number().int().nullable()
    })
  )
});

const workspaceDiff = z.object({ diff: z.string(), truncated: z.boolean() });

const sessionTranscript = z.object({
  sessionId,
  chatId: z.string().nullable().describe('The opencode chat the messages come from'),
  title: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['user', 'assistant']),
      text: z.string().describe('Text parts only; tool calls and reasoning are left out'),
      truncated: z.boolean(),
      createdAt: z.string().nullable(),
      author: sessionUser.nullable().describe('Who sent a user prompt, when it was attributed')
    })
  )
});

const shareLinkState = z.enum(['active', 'expired', 'revoked']);

const agentUsageWindow = z.object({
  usedPercent: z.number().min(0).max(100),
  leftPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable()
});

const agentUsage = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    provider: z.string(),
    loginMethod: z.string(),
    plan: z.string().nullable(),
    email: z.string().nullable().describe('Masked unless you are the host'),
    emailMasked: z.boolean(),
    fiveHour: agentUsageWindow.nullable(),
    sevenDay: agentUsageWindow.nullable(),
    fetchedAt: z.string()
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum(['no_token', 'api_key', 'unavailable'])
  })
]);

const usageCount = z.number().nonnegative().nullable();

const usageDisk = z.object({ usedBytes: usageCount, capacityBytes: usageCount });

const machineUsage = z.object({
  runner: sandboxRunnerId,
  status: sandboxStatus,
  startedAt: z.string().nullable().describe('When the current run started; null unless running'),
  uptimeSeconds: z.number().int().nullable(),
  lastActiveAt: z.string().nullable(),
  idleTimeoutMinutes: z.number().int().nullable().describe('null when idle stop is off'),
  stopsAt: z
    .string()
    .nullable()
    .describe('When the machine stops if nobody uses it; a busy agent pushes it back'),
  maxLifetimeHours: z.number().int().nullable(),
  lifetimeEndsAt: z.string().nullable().describe('When the max lifetime stops this run'),
  machines: z
    .object({
      count: z.number().int(),
      limit: z.number().int().nullable().describe('null when the owner is uncapped')
    })
    .nullable()
    .describe("The owner's machines against their cap"),
  kubernetes: z
    .object({
      cpu: z.object({
        usedMillicores: usageCount,
        limitMillicores: usageCount,
        requestMillicores: usageCount
      }),
      memory: z.object({ usedBytes: usageCount, limitBytes: usageCount }),
      disk: usageDisk.describe('The home volume')
    })
    .nullable(),
  vercel: z
    .object({
      vcpus: usageCount,
      memoryBytes: usageCount,
      sessionExpiresAt: z
        .string()
        .nullable()
        .describe('When the provider session times out unless it is extended'),
      sessionTimeoutMinutes: usageCount,
      activeCpuMs: usageCount.describe(
        'Active CPU this session: from Vercel once reported, otherwise measured in the guest'
      ),
      totalActiveCpuMs: usageCount.describe('Across every session of this machine'),
      networkIngressBytes: usageCount,
      networkEgressBytes: usageCount,
      totalIngressBytes: usageCount,
      totalEgressBytes: usageCount,
      disk: usageDisk
    })
    .nullable(),
  fetchedAt: z.string()
});

const shareLink = z.object({
  id: z.string().uuid(),
  sandboxId: z.string().uuid(),
  sessionId: sessionId.nullable().describe('null shares every active session of the machine'),
  session: z.object({ id: sessionId, title: z.string() }).nullable(),
  createdBy: sessionUser.nullable(),
  state: shareLinkState,
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string()
});

const projectLink = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  project: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  environment: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  envFile: z
    .string()
    .describe('Where the env file lands in the box, ~/.config/orchard/env/<slug>.env'),
  createdBy: sessionUser.nullable(),
  createdAt: z.string()
});

const previewDeployResult = z.object({
  session: sandboxSession,
  deploymentId: z.string().uuid(),
  environmentId: z.string().uuid(),
  url: z.string().nullable(),
  branch: z.string(),
  commit: z.string().nullable(),
  redeployed: z
    .boolean()
    .describe('True when an existing preview was rebuilt from the latest push'),
  skippedEnv: z
    .array(z.string())
    .describe('Copied vars left out because they reference resources bound to the source')
});

const credentialPresence = z.object({
  claude: z.boolean().describe('Whether a Claude Code OAuth token is stored'),
  openai: z.boolean().describe('Whether an OpenAI/Codex token is stored')
});

const shareRoutes = {
  'GET /share/sandbox/:token': {
    summary:
      "Open a share link: requires a signed-in member of the machine's organization; returns the shared sessions",
    response: z.object({
      link: z.object({
        id: z.string().uuid(),
        sessionId: sessionId.nullable(),
        expiresAt: z.string().nullable(),
        createdBy: sessionUser.nullable()
      }),
      sandbox: z.object({ id: z.string().uuid(), name: z.string(), status: sandboxStatus }),
      sessions: z.array(
        z.object({
          id: sessionId,
          title: z.string(),
          repo: z.string().nullable(),
          branch: z.string().nullable(),
          baseBranch: z.string().nullable(),
          status: z.enum(['active', 'archived']),
          prUrl: z.string().nullable(),
          createdAt: z.string()
        })
      )
    }),
    scope: 'read'
  },
  'GET /share/sandbox/:token/sessions/:sid/transcript': {
    summary: 'Read-only transcript of a shared session',
    request: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: sessionTranscript,
    scope: 'read'
  },
  'GET /share/sandbox/:token/sessions/:sid/changes': {
    summary: 'Changed files in a shared session worktree (machine must be running)',
    response: workspaceChanges,
    scope: 'read'
  },
  'GET /share/sandbox/:token/sessions/:sid/diff': {
    summary: 'Diff of a shared session worktree, whole tree or one file via ?file=',
    request: z.object({ file: z.string().optional() }),
    response: workspaceDiff,
    scope: 'read'
  }
} satisfies Record<`${string} /${string}`, RouteAttachment>;

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /sandboxes': {
    summary:
      'List your sandboxes; with ?organizationId= org owners and admins see every sandbox in that organization',
    response: z.object({
      sandboxes: z.array(sandbox),
      maxSandboxes: z.number().int().nullable(),
      runners: z.array(sandboxRunner),
      defaultRunner: sandboxRunnerId
        .nullable()
        .describe('The runner new sandboxes use when none is picked')
    }),
    scope: 'read'
  },
  'POST /sandboxes': {
    summary: 'Create an isolated cloud dev sandbox (Kata VM, internet egress only)',
    request: z.object({
      name: sandboxName.optional().describe('Defaults to "sandbox" (or a suffixed variant)'),
      repoUrl: z
        .string()
        .url()
        .optional()
        .describe('https git URL cloned into the sandbox on boot'),
      organizationId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Owning organization; required when you belong to more than one. Guests cannot create sandboxes.'
        ),
      sshIdentityId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'SSH identity to attach; defaults to your only identity when you have exactly one'
        ),
      setupScript: z
        .string()
        .max(65536)
        .nullable()
        .optional()
        .describe('Shell script run once as the dev user on first boot (logged to ~/.setup.log)'),
      runner: sandboxRunnerId
        .optional()
        .describe('Where the sandbox runs; defaults to the instance default runner')
    }),
    response: sandbox,
    scope: 'deploy'
  },
  'GET /sandboxes/credentials': {
    summary: 'Check which agent credentials are configured (presence only, never values)',
    response: credentialPresence,
    scope: 'read'
  },
  'PUT /sandboxes/credentials': {
    summary: 'Store or clear agent subscription tokens (encrypted at rest), null clears',
    request: z.object({
      claudeToken: z.string().max(8192).nullable().optional(),
      openaiToken: z.string().max(8192).nullable().optional()
    }),
    response: credentialPresence,
    scope: 'deploy'
  },
  'GET /sandboxes/:id': {
    summary: 'Get a sandbox',
    response: sandbox,
    scope: 'read'
  },
  'PATCH /sandboxes/:id': {
    summary: 'Rename a sandbox or replace its SSH public key set',
    request: z.object({
      name: sandboxName.optional(),
      sshIdentityId: z.string().uuid().optional(),
      setupScript: z.string().max(65536).nullable().optional()
    }),
    response: sandbox,
    scope: 'deploy'
  },
  'POST /sandboxes/:id/start': {
    summary: 'Resume a stopped sandbox (workspace and host key persist)',
    response: sandbox,
    scope: 'deploy'
  },
  'POST /sandboxes/:id/stop': {
    summary: 'Suspend a running sandbox (workspace and host key persist)',
    response: sandbox,
    scope: 'deploy'
  },
  'POST /sandboxes/:id/apply/retry': {
    summary:
      "Requeue the sandbox's failed apply operations (applyError) with fresh retries; host or org admin",
    response: z.object({
      success: z.literal(true),
      retried: z.number().int().describe('Failed operations put back on the queue')
    }),
    scope: 'deploy'
  },
  'DELETE /sandboxes/:id': {
    summary: 'Delete a sandbox and its persistent workspace',
    response: z.object({ success: z.boolean() }),
    scope: 'deploy'
  },
  'POST /sandboxes/:id/git/commit': {
    summary: 'Stage and commit inside a sandbox repo (all changes, or listed files)',
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      message: z.string().max(2000),
      files: z.array(z.string()).optional(),
      amend: z.boolean().optional(),
      signoff: z.boolean().optional(),
      trackedOnly: z.boolean().optional().describe('Stage tracked files only (git add -u)')
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/push': {
    summary:
      "Push the current branch to origin as the caller, with the caller's own GitHub token injected for that command only (force uses --force-with-lease). 409 github_not_linked when the caller has no linked GitHub account",
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      force: z.boolean().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/fetch': {
    summary:
      "Fetch all remotes and prune deleted branches with the caller's own GitHub token (409 github_not_linked without one)",
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree')
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/pull': {
    summary:
      "Pull the current branch, optionally with rebase, as the caller with the caller's own GitHub token (409 github_not_linked without one)",
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      rebase: z.boolean().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/uncommit': {
    summary: 'Soft reset the last commit, keeping its changes staged',
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree')
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/git/identity': {
    summary:
      'The git identity the caller commits and pushes as in this sandbox, and whether they can push',
    response: z.object({
      name: z.string(),
      email: z
        .string()
        .describe('<githubId>+<login>@users.noreply.github.com when GitHub is linked'),
      githubLogin: z.string().nullable(),
      githubLinked: z.boolean(),
      canCommit: z.boolean(),
      canPush: z.boolean().describe('false means show "Link your GitHub account to push"')
    })
  },
  'GET /sandboxes/:id/git/branches': {
    summary: 'List local branches with tracking info and remote branches',
    response: z.object({
      current: z.string().nullable(),
      local: z.array(
        z.object({
          name: z.string(),
          upstream: z.string().nullable(),
          ahead: z.number().int(),
          behind: z.number().int()
        })
      ),
      remote: z.array(z.string())
    }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/checkout': {
    summary: 'Switch branches, or create one with create:true (optionally from a base ref)',
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      branch: z.string(),
      create: z.boolean().optional(),
      from: z.string().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/branch/delete': {
    summary:
      "Delete a local branch, or a remote branch with remote:true (pushed with the caller's own GitHub token)",
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      branch: z.string(),
      remote: z.boolean().optional(),
      force: z.boolean().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/pr': {
    summary:
      "Open a GitHub pull request from the current branch of a sandbox repo with the caller's own GitHub account (409 github_not_linked without one)",
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      title: z.string().min(1).max(300),
      body: z.string().max(20000).optional(),
      base: z.string().max(200).optional(),
      draft: z.boolean().optional().describe('Open the pull request as a draft')
    }),
    response: z.object({
      url: z.string(),
      number: z.number().int().nullable().describe('Recorded on the session when one is given'),
      pushed: z
        .boolean()
        .describe(
          'The branch had no upstream on origin or unpushed commits, so it was pushed first as the caller'
        )
    }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/file': {
    summary:
      'Read a file from the sandbox workspace (?path=, optional ?repo= or ?session=, and ?ref=HEAD for the committed version)',
    response: z.object({
      content: z.string(),
      truncated: z.boolean(),
      exists: z.boolean().optional().describe('With ref=HEAD, false when the file is new')
    }),
    scope: 'exec'
  },
  'PUT /sandboxes/:id/file': {
    summary: 'Write a file in the sandbox workspace',
    request: z.object({
      repo: z.string().optional(),
      session: sessionId
        .optional()
        .describe('Worktree session; sets the working directory to its worktree'),
      path: z.string(),
      content: z.string().max(512000)
    }),
    response: z.object({ ok: z.boolean() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/boot': {
    summary: 'Boot progress of a starting sandbox, for a setup progress indicator',
    response: z.object({
      phase: z.string(),
      ready: z.boolean(),
      label: z.string()
    }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/repos': {
    summary: 'List git repositories cloned into the sandbox (one sandbox holds many repos)',
    response: z.object({
      repos: z.array(
        z.object({
          name: z.string(),
          branch: z.string().nullable(),
          dirtyFiles: z.number().int()
        })
      )
    }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/repos': {
    summary: 'Clone another repository into the sandbox (background, uses your GitHub token)',
    request: z.object({ repoUrl: z.string().url() }),
    response: z.object({ name: z.string() }),
    scope: 'deploy'
  },
  'POST /sandboxes/:id/repos/init': {
    summary: 'Create an empty git repository with an initial commit in the sandbox',
    request: z.object({ name: z.string().max(63) }),
    response: z.object({ name: z.string() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/changes': {
    summary: 'Git working-tree changes inside the sandbox workspace',
    response: z.object({
      isRepo: z.boolean(),
      branch: z.string().nullable(),
      files: z.array(
        z.object({
          path: z.string(),
          status: z.string(),
          additions: z.number().int().nullable(),
          deletions: z.number().int().nullable()
        })
      )
    }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/diff': {
    summary: 'Git diff inside the sandbox workspace, whole tree or one file via ?file=',
    response: z.object({ diff: z.string(), truncated: z.boolean() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/chat': {
    summary:
      'Cloud Code: send a message to the claude agent inside the sandbox; responds with an SSE stream of claude stream-json events plus a final {type: "done"|"error"} frame',
    request: z.object({
      message: z.string().min(1).max(32768),
      conversationId: z.string().uuid().optional(),
      repo: z.string().optional().describe('Working directory repo for a new conversation')
    }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/conversations': {
    summary: 'List conversations (metadata only; transcripts live on the sandbox disk)',
    response: z.object({
      conversations: z.array(
        z.object({
          id: z.string().uuid(),
          title: z.string(),
          repo: z.string().nullable(),
          hasSession: z.boolean(),
          createdAt: z.string(),
          updatedAt: z.string()
        })
      )
    }),
    scope: 'read'
  },
  'POST /sandboxes/:id/conversations': {
    summary: 'Create a conversation with an optional working-directory repo',
    request: z.object({
      title: z.string().max(120).optional(),
      repo: z.string().nullable().optional()
    }),
    scope: 'deploy'
  },
  'PATCH /sandboxes/:id/conversations/:cid': {
    summary: 'Rename a conversation (repo changeable only before its first message)',
    request: z.object({
      title: z.string().max(120).optional(),
      repo: z.string().nullable().optional()
    }),
    scope: 'deploy'
  },
  'DELETE /sandboxes/:id/conversations/:cid': {
    summary: 'Delete a conversation record (the session file stays on the sandbox disk)',
    response: z.object({ success: z.boolean() }),
    scope: 'deploy'
  },
  'GET /sandboxes/:id/conversations/:cid/history': {
    summary: 'Replay a conversation transcript from the claude session file on the sandbox disk',
    response: z.object({ events: z.array(z.unknown()), truncated: z.boolean() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/ssh': {
    summary:
      'WebSocket tunnel to the sandbox sshd (binary frames carry raw TCP bytes; used by orchard sandbox ssh/proxy)',
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions': {
    summary:
      'List worktree sessions with diffstat and ahead/behind (?includeArchived=1 adds archived ones)',
    response: z.object({ sessions: z.array(sandboxSession) }),
    scope: 'read'
  },
  'POST /sandboxes/:id/sessions': {
    summary:
      'Start a session: git worktree on orchard/<slug>, an opencode chat in it, and the repo setup script in the background',
    request: z.object({
      repo: z.string().max(120),
      baseBranch: z.string().max(200).nullable().optional().describe('Defaults to origin HEAD'),
      title: z.string().max(120).optional(),
      prompt: z.string().max(32768).optional().describe('Sent to the agent once the chat exists'),
      issue: z
        .object({ provider: z.enum(['github', 'linear']), ref: z.string().max(300) })
        .optional()
    }),
    response: sandboxSession,
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid': {
    summary: 'Get one session',
    response: sandboxSession,
    scope: 'read'
  },
  'PATCH /sandboxes/:id/sessions/:sid': {
    summary: 'Rename, archive (removes the worktree, keeps the branch) or restore a session',
    request: z.object({
      title: z.string().max(120).optional(),
      archived: z.boolean().optional()
    }),
    response: sandboxSession,
    scope: 'exec'
  },
  'DELETE /sandboxes/:id/sessions/:sid': {
    summary: 'Delete a session and its worktree; ?deleteBranch=1 also deletes its local branch',
    response: z.object({ success: z.boolean() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/chats': {
    summary: 'Opencode chats running in the session worktree (tabs)',
    response: z.object({
      chats: z.array(
        z.object({ id: z.string(), title: z.string(), createdAt: z.string().nullable() })
      )
    }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/sessions/:sid/chats': {
    summary: 'Start another opencode chat in the session worktree',
    request: z.object({ title: z.string().max(120).optional() }),
    response: z.object({ id: z.string(), title: z.string() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/scripts': {
    summary: 'Setup/run scripts and ports from .orchard/greenhouse.json, plus their state',
    response: sessionScripts,
    scope: 'exec'
  },
  'POST /sandboxes/:id/sessions/:sid/run': {
    summary: 'Start (or restart) or stop the run script in the tmux window `run`',
    request: z.object({ action: z.enum(['start', 'stop']) }),
    response: sessionScripts,
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/ports': {
    summary:
      'TCP ports the dev user is listening on (agent, ssh, tmux and language server processes excluded), flagged when started from this worktree, plus ports declared in .orchard/greenhouse.json that nothing listens on yet',
    response: z.object({
      previewPorts: z
        .array(z.number().int())
        .describe('Ports this machine can route a preview to; empty when previews are unavailable'),
      ports: z.array(
        z.object({
          port: z.number().int(),
          process: z.string().nullable(),
          previewUrl: z.string().nullable(),
          exposable: z.boolean().describe('The runner can route a preview to this port'),
          public: z
            .boolean()
            .describe('Served on a public URL (Vercel), not behind the Orchard preview proxy'),
          inSession: z.boolean(),
          loopbackOnly: z
            .boolean()
            .describe('Bound to 127.0.0.1 only, so a preview cannot reach it'),
          listening: z.boolean().describe('A process is listening on it right now'),
          declared: z
            .boolean()
            .describe('Listed in .orchard/greenhouse.json ports, which also allows previewing it')
        })
      )
    }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/checks': {
    summary:
      "The session's pull request and its check runs and statuses, read with the owner's GitHub token",
    response: z.object({
      pr: z
        .object({
          number: z.number().int(),
          url: z.string(),
          title: z.string(),
          state: z.enum(['open', 'merged', 'closed']),
          draft: z.boolean(),
          mergeable: z.boolean().nullable(),
          mergeableState: z.string().nullable(),
          headSha: z.string(),
          headBranch: z.string(),
          baseBranch: z.string()
        })
        .nullable(),
      checks: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          url: z.string().nullable(),
          logExcerpt: z.string().optional().describe('Tail of the log for failed checks')
        })
      )
    }),
    scope: 'read'
  },
  'POST /sandboxes/:id/sessions/:sid/git/merge': {
    summary:
      "Merge the session's pull request on GitHub with the caller's own GitHub account (squash or rebase, never a merge commit; 409 github_not_linked without one)",
    request: z.object({ method: z.enum(['squash', 'rebase']).optional() }),
    response: z.object({ merged: z.boolean(), sha: z.string().nullable(), message: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/fs/mkdir': {
    summary: 'Create a directory (and parents) inside a session worktree or repo',
    request: fsRequest,
    response: z.object({ ok: z.boolean(), path: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/fs/rename': {
    summary: 'Move a file or directory to `to`, refusing to overwrite or leave the workspace',
    request: fsRequest,
    response: z.object({ ok: z.boolean(), path: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/fs/delete': {
    summary: 'Delete a file or directory (symlinks are removed, never followed)',
    request: fsRequest,
    response: z.object({ ok: z.boolean(), path: z.string() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/members': {
    summary: 'The host, the guests and the caller role (emails only for the host and org admins)',
    response: z.object({
      owner: memberUser.nullable(),
      members: z.array(sandboxMember),
      myRole: z.enum(['owner', 'collaborator', 'viewer', 'admin'])
    }),
    scope: 'read'
  },
  'POST /sandboxes/:id/members': {
    summary: 'Invite someone from the same organization as a guest or read-only guest (host only)',
    request: z.object({
      userId: z.string().uuid().optional(),
      email: z.string().max(320).optional(),
      role: memberRole
    }),
    response: sandboxMember,
    scope: 'exec'
  },
  'PATCH /sandboxes/:id/members/:userId': {
    summary: 'Change a guest role (host only); live connections pick it up immediately',
    request: z.object({ role: memberRole }),
    response: sandboxMember,
    scope: 'exec'
  },
  'DELETE /sandboxes/:id/members/:userId': {
    summary:
      'Remove a guest (host only) or leave a sandbox shared with you; kicks live connections',
    response: z.object({ success: z.boolean() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/comments': {
    summary: 'Team chat in a session, oldest first (?since=<iso> returns only newer ones)',
    response: z.object({ comments: z.array(sessionComment) }),
    scope: 'read'
  },
  'POST /sandboxes/:id/sessions/:sid/comments': {
    summary: 'Post a human-only message to the session thread; never sent to the agent',
    request: z.object({ chatId: z.string().max(64), body: z.string().min(1).max(4000) }),
    response: sessionComment,
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/authors': {
    summary: 'Who sent each prompt, keyed by opencode message id',
    response: z.object({ authors: z.record(z.string(), sessionUser) }),
    scope: 'read'
  },
  'GET /sandboxes/:id/links': {
    summary: 'Orchard projects attached to the sandbox and where their env files land',
    response: z.object({ links: z.array(projectLink) }),
    scope: 'read'
  },
  'POST /sandboxes/:id/links': {
    summary:
      'Attach a project environment (host only, needs env-read on the project, same org). Its shared vars and DATABASE_URL are written to the box at sync time; secret values stay write-only',
    request: z.object({
      projectId: z.string().uuid(),
      environmentId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('Defaults to the project default environment')
    }),
    response: projectLink,
    scope: 'exec'
  },
  'DELETE /sandboxes/:id/links/:projectId': {
    summary: 'Detach a project (host only); its env file is removed on the next sync',
    response: z.object({ success: z.boolean() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/sessions/:sid/preview-deploy': {
    summary:
      'Push the session branch and deploy it to the gh-<slug> preview environment of a project (host only, needs project edit). Calling it again redeploys the latest commit',
    request: z.object({
      projectId: z.string().uuid(),
      deploymentId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .describe('Deployment whose config is copied; defaults to the one building the same repo')
    }),
    response: previewDeployResult,
    scope: 'deploy'
  },
  'DELETE /sandboxes/:id/sessions/:sid/preview-deploy': {
    summary: 'Tear down the session preview environment (host only, needs project edit)',
    response: z.object({ session: sandboxSession, removed: z.boolean() }),
    scope: 'deploy'
  },
  'GET /sandboxes/:id/preview-token': {
    summary:
      'A one-time preview link for ?port= (Kubernetes: 60s single-use exchange for a cookie on the preview host; Vercel: the public port URL)',
    response: z.object({
      url: z.string(),
      public: z.boolean(),
      expiresAt: z.string().nullable()
    }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/sessions/:sid/prompt': {
    summary:
      'Prompt the session agent as yourself (guest or host): the prompt is attributed to you like one sent from the web composer',
    request: z.object({ text: z.string().min(1).max(32768) }),
    response: z.object({ messageId: z.string(), chatId: z.string(), sessionId }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/sessions/:sid/transcript': {
    summary:
      'The latest messages of the session agent chat as plain text (?limit=1..200, default 30)',
    request: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
    response: sessionTranscript,
    scope: 'exec'
  },
  'GET /sandboxes/:id/agent/usage': {
    summary:
      "The host's Claude subscription limits that this machine's agent spends (guest or host): 5-hour and 7-day percentages with reset times, plan and login. Cached 60s; available is false for API keys or when Anthropic does not answer",
    response: agentUsage,
    scope: 'read'
  },
  'GET /sandboxes/:id/usage': {
    summary:
      'Usage and limits of the machine (anyone who can see it, including org admins): uptime, idle stop and max lifetime, the owner machine count, and live CPU, memory and disk (Kubernetes, cached 15s) or allocation, session end, active CPU and network (Vercel, cached 30s). Anything not measurable is null',
    response: machineUsage,
    scope: 'read'
  },
  'POST /sandboxes/:id/fork': {
    summary:
      'Fork the machine (host only): a new machine owned by you restored from this one, with its sessions. 409 when the runner or the storage class cannot snapshot',
    request: z.object({ name: sandboxName.optional() }),
    response: sandbox,
    scope: 'deploy'
  },
  'GET /sandboxes/:id/share-links': {
    summary: 'Read-only share links for this machine (host only); tokens are never returned again',
    response: z.object({ links: z.array(shareLink) }),
    scope: 'read'
  },
  'POST /sandboxes/:id/share-links': {
    summary:
      'Create a read-only share link for org teammates (host only). The token is returned once; only its sha256 is stored',
    request: z.object({
      sessionId: sessionId.nullable().optional(),
      expiresInHours: z.number().int().min(1).max(720).optional().describe('Default 168 (7 days)')
    }),
    response: shareLink.extend({ token: z.string(), url: z.string() }),
    scope: 'deploy'
  },
  'DELETE /sandboxes/:id/share-links/:linkId': {
    summary: 'Revoke a share link (host only); open viewers lose access on their next request',
    response: shareLink,
    scope: 'deploy'
  },
  ...shareRoutes,
  'GET /share/sandbox': {
    ...shareRoutes['GET /share/sandbox/:token'],
    summary:
      'Open a share link with the token in the X-Orchard-Share-Token header instead of the path, so it stays out of access logs'
  },
  'GET /share/sandbox/sessions/:sid/transcript': {
    ...shareRoutes['GET /share/sandbox/:token/sessions/:sid/transcript'],
    summary: 'Read-only transcript of a shared session (token in X-Orchard-Share-Token)'
  },
  'GET /share/sandbox/sessions/:sid/changes': {
    ...shareRoutes['GET /share/sandbox/:token/sessions/:sid/changes'],
    summary: 'Changed files in a shared session worktree (token in X-Orchard-Share-Token)'
  },
  'GET /share/sandbox/sessions/:sid/diff': {
    ...shareRoutes['GET /share/sandbox/:token/sessions/:sid/diff'],
    summary: 'Diff of a shared session worktree (token in X-Orchard-Share-Token)'
  }
};
