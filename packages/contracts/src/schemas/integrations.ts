import { z } from 'zod';
import type { RouteAttachment } from '../types';

const issueSummary = z.object({
  provider: z.enum(['github', 'linear']),
  ref: z
    .string()
    .describe('Pass back as issue.ref when creating a session (owner/repo#123 or ENG-123)'),
  title: z.string(),
  url: z.string().nullable(),
  labels: z.array(z.string()),
  state: z.string().nullable(),
  updatedAt: z.string().nullable()
});

const linearStatus = z.object({
  connected: z.boolean(),
  workspaceName: z.string().nullable()
});

const webhookAck = z.object({
  received: z.boolean().optional(),
  action: z.enum(['queued', 'ignored']).optional(),
  reason: z.string().optional()
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /sandboxes/:id/issues': {
    summary:
      'Open GitHub issues for a repo cloned in the sandbox (?provider=github&repo=<dir>&q=), or Linear issues with provider=linear. Guest role required',
    request: z.object({
      provider: z.enum(['github', 'linear']).optional(),
      repo: z.string().max(120).optional(),
      q: z.string().max(200).optional()
    }),
    response: z.object({
      repo: z.string().nullable().describe('owner/name the repo directory maps to'),
      connected: z.boolean().optional(),
      issues: z.array(issueSummary)
    }),
    scope: 'read'
  },
  'GET /integrations/linear/issues': {
    summary: 'Open Linear issues assigned to you, or matching ?q= (title or ENG-123)',
    request: z.object({ q: z.string().max(200).optional() }),
    response: z.object({ connected: z.boolean(), issues: z.array(issueSummary) }),
    scope: 'read'
  },
  'GET /users/me/integrations': {
    summary:
      'Accounts linked for Greenhouse kickoffs (github, linear, slack); never returns secrets',
    response: z.object({
      integrations: z.array(
        z.object({
          provider: z.enum(['github', 'linear', 'slack']),
          account: z
            .string()
            .nullable()
            .describe('GitHub login, Linear workspace name or Slack team id'),
          linkedAt: z.string().nullable()
        })
      )
    }),
    scope: 'read'
  },
  'POST /integrations/slack/link': {
    summary:
      'Confirm a one-time Slack link token from /greenhouse link (10 minutes, single use) and link that Slack user to you',
    request: z.object({ token: z.string().length(43) }),
    response: z.object({ connected: z.literal(true), teamId: z.string() })
  },
  'DELETE /users/me/integrations/slack': {
    summary: 'Unlink your Slack account',
    response: z.object({ connected: z.literal(false) })
  },
  'GET /users/me/integrations/linear': {
    summary: 'Whether a Linear API key is connected, and its workspace name',
    response: linearStatus,
    scope: 'read'
  },
  'PUT /users/me/integrations/linear': {
    summary: 'Connect a Linear personal API key; it is checked against Linear and stored encrypted',
    request: z.object({ apiKey: z.string().min(1).max(200) }),
    response: linearStatus
  },
  'DELETE /users/me/integrations/linear': {
    summary: 'Forget the stored Linear API key',
    response: linearStatus
  },
  'POST /integrations/linear/webhook': {
    summary:
      'Linear webhook receiver (Linear-Signature HMAC). A comment starting with /greenhouse starts a session',
    response: webhookAck
  },
  'POST /integrations/slack/commands': {
    summary:
      'Slack slash command receiver (/greenhouse <prompt>), signed with the app signing secret',
    response: z.object({ response_type: z.string().optional(), text: z.string().optional() })
  },
  'POST /integrations/slack/events': {
    summary: 'Slack Events API receiver: url_verification and app_mention',
    response: z.object({
      challenge: z.string().optional(),
      ok: z.boolean().optional(),
      ignored: z.string().optional()
    })
  }
};
