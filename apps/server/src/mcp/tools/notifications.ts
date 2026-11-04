import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OrchardClient, path, query } from '../client';
import { json, paginate } from './reply';
import { pageInput } from './inputs';
import { NOTIFICATION_EVENTS, RULE_SCOPE_TYPES } from '../../notifications/notification-events';

// Sourced from the server's own list rather than redeclared, so it cannot drift
// and stop offering job and archiving events.
const EVENT_NAMES = NOTIFICATION_EVENTS.join(', ');
const SCOPE_VALUES = RULE_SCOPE_TYPES as unknown as [string, ...string[]];

export function registerNotificationTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_notification_channels',
    {
      description: `List notification destinations (Discord, Slack, email, or generic webhook). A channel is only a destination: what it receives is set by notification rules.
Without a scope this is every destination in the org, with health, rule count and last delivery status, and needs org admin.
With a scope it is what that project or resource may route to (its own destinations plus the ones it inherits), and needs only org membership.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        scopeType: z
          .enum(SCOPE_VALUES)
          .optional()
          .describe('org, project, deployment, database, or job'),
        scopeId: z.guid().optional().describe('The UUID of the scope (omit for scopeType=org)')
      }
    },
    async ({ organizationId, scopeType, scopeId }) => {
      const result = await client.get(
        path`/organizations/${organizationId}/notification-channels` + query({ scopeType, scopeId })
      );
      return json(result);
    }
  );

  server.registerTool(
    'create_notification_channel',
    {
      description: `Create a notification destination. This only says where messages go; create a notification rule afterwards to say what it should receive, otherwise the channel stays silent.
For discord/slack/webhook, pass the webhook URL in "url". For email, pass "recipients" (org members for an org-wide destination, the project's own people for a scoped one).
For webhook channels the response includes a one-time signing secret. Surface it to the user. It cannot be retrieved again.
A destination belongs to a scope: org-wide (the default) needs org admin, and a project or resource scope needs admin on the owning project, which is how one app gets its own webhook without an org admin. Only rules at or below the owning scope can route to it.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        type: z.enum(['discord', 'slack', 'webhook', 'email']).describe('Channel type'),
        name: z.string().max(100).describe('Display name, e.g. "#deploys"'),
        url: z.string().optional().describe('Webhook URL (discord/slack/webhook types)'),
        recipients: z
          .array(z.string())
          .max(100)
          .optional()
          .describe('Email recipients (email type, members of the owning scope only)'),
        scopeType: z
          .enum(SCOPE_VALUES)
          .optional()
          .describe('Who owns this destination, default org'),
        scopeId: z.guid().optional().describe('The UUID of the scope (omit for scopeType=org)')
      }
    },
    async ({ organizationId, type, name, url, recipients, scopeType, scopeId }) => {
      const result = await client.post(
        path`/organizations/${organizationId}/notification-channels`,
        {
          type,
          name,
          config: type === 'email' ? { recipients: recipients ?? [] } : { url },
          scopeType: scopeType ?? 'org',
          scopeId: scopeId ?? null
        }
      );
      return json(result);
    }
  );

  server.registerTool(
    'update_notification_channel',
    {
      description: `Update a notification destination's name, webhook URL, email recipients, or enabled state. Re-enabling a channel also clears its failure counter, so use this after fixing a broken webhook. Only provided fields change; the channel type cannot be changed. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The notification channel UUID'),
        name: z.string().max(100).optional().describe('New display name'),
        url: z.string().optional().describe('New webhook URL (keeps the existing signing secret)'),
        recipients: z.array(z.string()).max(100).optional().describe('Replace email recipients'),
        enabled: z
          .boolean()
          .optional()
          .describe('false pauses the channel, true resumes it and resets its breaker')
      }
    },
    async ({ organizationId, channelId, name, url, recipients, enabled }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (enabled !== undefined) body.enabled = enabled;
      if (url !== undefined || recipients !== undefined) {
        body.config = {
          ...(url !== undefined ? { url } : {}),
          ...(recipients !== undefined ? { recipients } : {})
        };
      }
      const result = await client.patch(
        path`/organizations/${organizationId}/notification-channels/${channelId}`,
        body
      );
      return json(result);
    }
  );

  server.registerTool(
    'list_notification_rules',
    {
      description: `List the notification rules that route events to channels. Pass a scope to see everything that applies there, including rules inherited from the project and the organization (each is flagged with "inherited"). Omit the scope to list every rule in the org.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        scopeType: z
          .enum(SCOPE_VALUES)
          .optional()
          .describe('org, project, deployment, database, or job'),
        scopeId: z.guid().optional().describe('The UUID of the scope (omit for scopeType=org)')
      }
    },
    async ({ organizationId, scopeType, scopeId }) => {
      const result = await client.get(
        path`/organizations/${organizationId}/notification-rules` + query({ scopeType, scopeId })
      );
      return json(result);
    }
  );

  server.registerTool(
    'create_notification_rule',
    {
      description: `Route events to a channel at a given scope. Rules add up as you go outwards, so a deployment rule fires alongside the project and org rules that also match.
Use mode="mute" to silence a specific channel for this scope: a mute at a narrower scope beats a deliver at a broader one, which is how you quieten one noisy deployment without touching the org-wide rule.
Events must be possible at the scope (a database cannot emit deploy events). Org-scope rules need org admin; narrower scopes need admin on the owning project.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The destination channel UUID'),
        scopeType: z.enum(SCOPE_VALUES).describe('org, project, deployment, database, or job'),
        scopeId: z.guid().optional().describe('The UUID of the scope (omit for scopeType=org)'),
        events: z
          .array(z.string())
          .max(500)
          .min(1)
          .describe(`Events this rule matches, e.g. ${EVENT_NAMES}`),
        mode: z.enum(['deliver', 'mute']).optional().describe('deliver (default) or mute')
      }
    },
    async ({ organizationId, channelId, scopeType, scopeId, events, mode }) => {
      const result = await client.post(path`/organizations/${organizationId}/notification-rules`, {
        channelId,
        scopeType,
        scopeId: scopeId ?? null,
        events,
        mode: mode ?? 'deliver'
      });
      return json(result);
    }
  );

  server.registerTool(
    'update_notification_rule',
    {
      description: `Change a rule's events, mode, or enabled state. The scope and channel are fixed at creation; delete and recreate to move a rule.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        ruleId: z.guid().describe('The notification rule UUID'),
        events: z
          .array(z.string())
          .max(500)
          .min(1)
          .optional()
          .describe(`Replace matched events, e.g. ${EVENT_NAMES}`),
        mode: z.enum(['deliver', 'mute']).optional().describe('deliver or mute'),
        enabled: z.boolean().optional().describe('false stops the rule matching')
      }
    },
    async ({ organizationId, ruleId, events, mode, enabled }) => {
      const body: Record<string, unknown> = {};
      if (events !== undefined) body.events = events;
      if (mode !== undefined) body.mode = mode;
      if (enabled !== undefined) body.enabled = enabled;
      const result = await client.patch(
        path`/organizations/${organizationId}/notification-rules/${ruleId}`,
        body
      );
      return json(result);
    }
  );

  server.registerTool(
    'delete_notification_rule',
    {
      description: `Delete a notification rule. The channel it pointed at is left alone.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        ruleId: z.guid().describe('The notification rule UUID')
      }
    },
    async ({ organizationId, ruleId }) => {
      const result = await client.delete(
        path`/organizations/${organizationId}/notification-rules/${ruleId}`
      );
      return json(result);
    }
  );

  server.registerTool(
    'test_notification_channel',
    {
      description: `Send a test notification through a channel to check that it works. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The notification channel UUID')
      }
    },
    async ({ organizationId, channelId }) => {
      const result = await client.post(
        path`/organizations/${organizationId}/notification-channels/${channelId}/test`,
        {}
      );
      return json(result);
    }
  );

  server.registerTool(
    'replay_notification_channel',
    {
      description: `Re-send everything a channel's rules would have matched over the last N hours. Use this after fixing a webhook that was down: the events were stored even though delivery failed. Only events the channel's own rules match are replayed. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The notification channel UUID'),
        sinceHours: z
          .number()
          .min(1)
          .max(72)
          .optional()
          .describe('How far back to replay, default 24')
      }
    },
    async ({ organizationId, channelId, sinceHours }) => {
      const result = await client.post(
        path`/organizations/${organizationId}/notification-channels/${channelId}/replay`,
        { sinceHours: sinceHours ?? 24 }
      );
      return json(result);
    }
  );

  server.registerTool(
    'list_notification_deliveries',
    {
      description: `List recent delivery attempts for a notification channel, including attempt count, HTTP status, errors, when the next retry is due, and whether messages were coalesced into a digest. This is the place to look when a channel isn't receiving alerts. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The notification channel UUID'),
        ...pageInput
      }
    },
    async ({ organizationId, channelId, limit, cursor }) => {
      const result = await client.get(
        path`/organizations/${organizationId}/notification-channels/${channelId}/deliveries`
      );
      return json(Array.isArray(result) ? paginate(result, { limit, cursor }) : result);
    }
  );
}
