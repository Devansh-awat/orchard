import type { McpServer } from '@modelcontextprotocol/server';
import type { McpRegister } from '@orchardlabs/graft-sdk/server';
import { z } from 'zod';

export type OrchardClient = Parameters<McpRegister>[1];

export function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

const sandboxId = z.string().uuid().describe('The sandbox (Greenhouse machine) UUID');
const sessionId = z.string().uuid().describe('The session UUID (from list_sandbox_sessions)');

const sandboxPath = (id: string, ...rest: string[]) =>
  [`/sandboxes/${encodeURIComponent(id)}`, ...rest.map(encodeURIComponent)].join('/');

export function registerSandboxTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_sandboxes',
    {
      description: `List the Greenhouse machines (sandboxes) you own or that were shared with you, with their status, runner and your role on each (owner = host, collaborator = guest, viewer = read-only guest, admin = org admin with lifecycle only). Pass organizationId to also see every machine in an org you administer; on machines where your role is admin you can start, stop and delete them, but sessions, files, transcripts, terminals and previews stay closed to you unless the host invites you. The result also says how many machines you may own and which runners are available.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        organizationId: z.string().uuid().optional().describe('Limit to one organization')
      }
    },
    async ({ organizationId }) => {
      const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';
      return json(await client.get(`/sandboxes${query}`));
    }
  );

  server.registerTool(
    'get_sandbox',
    {
      description: `Get one Greenhouse machine: status, desired state, whether a change is still applying, runner, image, owner and your role on it. Org admins can read this for any machine in their org; everything inside the machine needs an invite.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { sandboxId }
    },
    async ({ sandboxId: id }) => json(await client.get(sandboxPath(id)))
  );

  server.registerTool(
    'start_sandbox',
    {
      description: `Start a stopped Greenhouse machine. Guests, the host and org admins can start it. Returns immediately with status "starting"; poll get_sandbox until it is "running" before creating sessions or prompting.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: { sandboxId }
    },
    async ({ sandboxId: id }) => json(await client.post(sandboxPath(id, 'start')))
  );

  server.registerTool(
    'stop_sandbox',
    {
      description: `Stop a Greenhouse machine. Its disk is kept and sessions resume on the next start, but running agents, terminals and dev servers are killed. Host or org admin only.`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: { sandboxId }
    },
    async ({ sandboxId: id }) => json(await client.post(sandboxPath(id, 'stop')))
  );

  server.registerTool(
    'list_sandbox_sessions',
    {
      description: `List the agent sessions on a Greenhouse machine. Each session is a git worktree on its own branch (orchard/<slug>) with an agent chat (opencode, Claude Code, fx or Codex), plus its agent, diffstat, ahead/behind, activity (idle, working, needs_input, done) and pull request.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        sandboxId,
        includeArchived: z.boolean().optional().describe('Include archived sessions')
      }
    },
    async ({ sandboxId: id, includeArchived }) =>
      json(
        await client.get(
          `${sandboxPath(id, 'sessions')}${includeArchived ? '?includeArchived=1' : ''}`
        )
      )
  );

  server.registerTool(
    'create_sandbox_session',
    {
      description: `Start a new agent session on a running Greenhouse machine: creates a git worktree for \`repo\` on a fresh branch and an agent chat in it. Pass \`agent\` to pick the coding agent: "opencode" (the default), or "acp:claude", "acp:opencode", "acp:fx", "acp:codex" for agents driven over the Agent Client Protocol. When \`prompt\` is given it is sent as your first prompt (attributed to you, like prompt_sandbox_session) and the agent starts working right away. Requires guest access or higher.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        sandboxId,
        repo: z
          .string()
          .max(120)
          .describe('Repository directory name inside the machine (see the machine repos)'),
        baseBranch: z
          .string()
          .max(255)
          .optional()
          .describe("Branch to start from (defaults to the repo's default branch)"),
        title: z.string().max(120).optional().describe('Session title'),
        prompt: z.string().max(32768).optional().describe('First instruction for the agent'),
        agent: z
          .string()
          .regex(/^(opencode|acp:[A-Za-z0-9_-]{1,28})$/)
          .optional()
          .describe('Coding agent: opencode, acp:claude, acp:opencode, acp:fx or acp:codex')
      }
    },
    async ({ sandboxId: id, ...body }) => json(await client.post(sandboxPath(id, 'sessions'), body))
  );

  server.registerTool(
    'prompt_sandbox_session',
    {
      description: `Send a prompt to the agent in a session. The prompt is recorded as yours (it shows your avatar in the shared transcript) and the agent runs with the host's credentials, so this needs guest access or higher. Returns as soon as the agent accepts it; read progress with get_sandbox_session_transcript and list_sandbox_sessions (activity).`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        sandboxId,
        sessionId,
        text: z.string().min(1).max(32768).describe('What you want the agent to do')
      }
    },
    async ({ sandboxId: id, sessionId: sid, text }) =>
      json(await client.post(sandboxPath(id, 'sessions', sid, 'prompt'), { text }))
  );

  server.registerTool(
    'get_sandbox_session_diff',
    {
      description: `Read what a session changed: the list of changed files with line counts, and the unified diff of uncommitted work in its worktree (capped at 200KB, \`truncated\` says when). Pass \`file\` to diff a single file. The machine must be running.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        sandboxId,
        sessionId,
        file: z.string().max(1024).optional().describe('Relative path of one file to diff')
      }
    },
    async ({ sandboxId: id, sessionId: sid, file }) => {
      const session = `session=${encodeURIComponent(sid)}`;
      const fileQuery = file ? `&file=${encodeURIComponent(file)}` : '';
      const [changes, diff] = await Promise.all([
        client.get(`${sandboxPath(id, 'changes')}?${session}`),
        client.get(`${sandboxPath(id, 'diff')}?${session}${fileQuery}`)
      ]);
      return json({ changes, diff });
    }
  );

  server.registerTool(
    'get_sandbox_session_transcript',
    {
      description: `Read the latest messages of a session's agent chat as plain text: your and your teammates' prompts (with who sent them) and the agent's replies. Tool calls and reasoning are left out.`,
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        sandboxId,
        sessionId,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('How many of the latest messages to return (default 30)')
      }
    },
    async ({ sandboxId: id, sessionId: sid, limit }) =>
      json(
        await client.get(
          `${sandboxPath(id, 'sessions', sid, 'transcript')}${limit ? `?limit=${limit}` : ''}`
        )
      )
  );

  server.registerTool(
    'create_sandbox_session_pr',
    {
      description: `Open a GitHub pull request for a session's branch, using the caller's own linked GitHub account (host or guest). Pushes the branch first, as the caller, when it has no upstream on origin or has unpushed commits. Fails with github_not_linked if the caller hasn't linked GitHub. Commit the work first (the agent can when asked); uncommitted changes aren't included.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        sandboxId,
        sessionId,
        title: z.string().min(1).max(256).describe('Pull request title'),
        body: z.string().max(65536).optional().describe('Pull request description (markdown)'),
        base: z
          .string()
          .max(255)
          .optional()
          .describe("Base branch (defaults to the session's base branch)"),
        draft: z.boolean().optional().describe('Open the pull request as a draft')
      }
    },
    async ({ sandboxId: id, sessionId: sid, ...rest }) =>
      json(await client.post(sandboxPath(id, 'git', 'pr'), { session: sid, ...rest }))
  );
}
