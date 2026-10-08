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
  lastActiveAt: z.string().nullable()
});

const credentialPresence = z.object({
  claude: z.boolean().describe('Whether a Claude Code OAuth token is stored'),
  openai: z.boolean().describe('Whether an OpenAI/Codex token is stored')
});

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
  'DELETE /sandboxes/:id': {
    summary: 'Delete a sandbox and its persistent workspace',
    response: z.object({ success: z.boolean() }),
    scope: 'deploy'
  },
  'POST /sandboxes/:id/git/commit': {
    summary: 'Stage and commit inside a sandbox repo (all changes, or listed files)',
    request: z.object({
      repo: z.string(),
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
    summary: 'Push the current branch to origin (force uses --force-with-lease)',
    request: z.object({ repo: z.string(), force: z.boolean().optional() }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/fetch': {
    summary: 'Fetch all remotes and prune deleted branches',
    request: z.object({ repo: z.string() }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/pull': {
    summary: 'Pull the current branch, optionally with rebase',
    request: z.object({ repo: z.string(), rebase: z.boolean().optional() }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/uncommit': {
    summary: 'Soft reset the last commit, keeping its changes staged',
    request: z.object({ repo: z.string() }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
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
      repo: z.string(),
      branch: z.string(),
      create: z.boolean().optional(),
      from: z.string().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/branch/delete': {
    summary: 'Delete a local branch, or a remote branch with remote:true',
    request: z.object({
      repo: z.string(),
      branch: z.string(),
      remote: z.boolean().optional(),
      force: z.boolean().optional()
    }),
    response: z.object({ ok: z.boolean(), output: z.string() }),
    scope: 'exec'
  },
  'POST /sandboxes/:id/git/pr': {
    summary: 'Open a GitHub pull request from the current branch of a sandbox repo',
    request: z.object({
      repo: z.string(),
      title: z.string().min(1).max(300),
      body: z.string().max(20000).optional(),
      base: z.string().max(200).optional()
    }),
    response: z.object({ url: z.string() }),
    scope: 'exec'
  },
  'GET /sandboxes/:id/file': {
    summary: 'Read a file from the sandbox workspace (?path= and optional ?repo=)',
    response: z.object({ content: z.string(), truncated: z.boolean() }),
    scope: 'exec'
  },
  'PUT /sandboxes/:id/file': {
    summary: 'Write a file in the sandbox workspace',
    request: z.object({
      repo: z.string().optional(),
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
  }
};
