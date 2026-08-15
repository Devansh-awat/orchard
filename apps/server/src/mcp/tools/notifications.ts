import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';
import {
  NOTIFICATION_EVENTS,
  RULE_SCOPE_TYPES,
} from '../../notifications/notification-events';

// Sourced from the server's own list rather than redeclared, which is how the
// old copy silently drifted and stopped offering job and archiving events.
const EVENT_VALUES = NOTIFICATION_EVENTS as unknown as [string, ...string[]];
const SCOPE_VALUES = RULE_SCOPE_TYPES as unknown as [string, ...string[]];

export function registerNotificationTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_notification_channels',
    {
      description: `List notification destinations (Discord, Slack, email, or generic webhook). A channel is only a destination: what it receives is set by notification rules.
Without a scope this is every destination in the org, with health, rule count and last delivery status, and needs org admin.
With a scope it is what that project or resource may route to (its own destinations plus the ones it inherits), and needs only org membership.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        scopeType: z.enum(SCOPE_VALUES).optional().describe('org, project, deployment, database, or job'),
        scopeId: z.string().optional().describe('The UUID of the scope (omit for scopeType=org)'),
      },
    },
    async ({ organizationId, scopeType, scopeId }) => {
      const params = new URLSearchParams();
      if (scopeType) params.set('scopeType', scopeType);
      if (scopeId) params.set('scopeId', scopeId);
      const query = params.toString();
      const result = await client.get(
        `/organizations/${organizationId}/notification-channels${query ? `?${query}` : ''}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'create_notification_channel',
    {
      description: `Create a notification destination. This only says where messages go; create a notification rule afterwards to say what it should receive, otherwise the channel stays silent.
For discord/slack/webhook, pass the webhook URL in "url". For email, pass "recipients" (org members for an org-wide destination, the project's own people for a scoped one).
For webhook channels the response includes a one-time signing secret — surface it to the user, it cannot be retrieved again.
A destination belongs to a scope: org-wide (the default) needs org admin, and a project or resource scope needs admin on the owning project, which is how one app gets its own webhook without an org admin. Only rules at or below the owning scope can route to it.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        type: z.enum(['discord', 'slack', 'webhook', 'email']).describe('Channel type'),
        name: z.string().max(100).describe('Display name, e.g. "#deploys"'),
        url: z.string().optional().describe('Webhook URL (discord/slack/webhook types)'),
        recipients: z.array(z.string()).optional().describe('Email recipients (email type, members of the owning scope only)'),
        scopeType: z.enum(SCOPE_VALUES).optional().describe('Who owns this destination, default org'),
        scopeId: z.string().optional().describe('The UUID of the scope (omit for scopeType=org)'),
      },
    },
    async ({ organizationId, type, name, url, recipients, scopeType, scopeId }) => {
      const result = await client.post(`/organizations/${organizationId}/notification-channels`, {
        type,
        name,
        config: type === 'email' ? { recipients: recipients ?? [] } : { url },
        scopeType: scopeType ?? 'org',
        scopeId: scopeId ?? null,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_notification_channel',
    {
      description: `Update a notification destination's name, webhook URL, email recipients, or enabled state. Re-enabling a channel also clears its failure counter, so use this after fixing a broken webhook. Only provided fields change; the channel type cannot be changed. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
        name: z.string().max(100).optional().describe('New display name'),
        url: z.string().optional().describe('New webhook URL (keeps the existing signing secret)'),
        recipients: z.array(z.string()).optional().describe('Replace email recipients'),
        enabled: z.boolean().optional().describe('false pauses the channel, true resumes it and resets its breaker'),
      },
    },
    async ({ organizationId, channelId, name, url, recipients, enabled }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (enabled !== undefined) body.enabled = enabled;
      if (url !== undefined || recipients !== undefined) {
        body.config = { ...(url !== undefined ? { url } : {}), ...(recipients !== undefined ? { recipients } : {}) };
      }
      const result = await client.patch(`/organizations/${organizationId}/notification-channels/${channelId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_notification_rules',
    {
      description: `List the notification rules that route events to channels. Pass a scope to see everything that applies there, including rules inherited from the project and the organization (each is flagged with "inherited"). Omit the scope to list every rule in the org.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        scopeType: z.enum(SCOPE_VALUES).optional().describe('org, project, deployment, database, or job'),
        scopeId: z.string().optional().describe('The UUID of the scope (omit for scopeType=org)'),
      },
    },
    async ({ organizationId, scopeType, scopeId }) => {
      const params = new URLSearchParams();
      if (scopeType) params.set('scopeType', scopeType);
      if (scopeId) params.set('scopeId', scopeId);
      const query = params.toString();
      const result = await client.get(
        `/organizations/${organizationId}/notification-rules${query ? `?${query}` : ''}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'create_notification_rule',
    {
      description: `Route events to a channel at a given scope. Rules add up as you go outwards, so a deployment rule fires alongside the project and org rules that also match.
Use mode="mute" to silence a specific channel for this scope: a mute at a narrower scope beats a deliver at a broader one, which is how you quieten one noisy deployment without touching the org-wide rule.
Events must be possible at the scope (a database cannot emit deploy events). Org-scope rules need org admin; narrower scopes need admin on the owning project.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The destination channel UUID'),
        scopeType: z.enum(SCOPE_VALUES).describe('org, project, deployment, database, or job'),
        scopeId: z.string().optional().describe('The UUID of the scope (omit for scopeType=org)'),
        events: z.array(z.enum(EVENT_VALUES)).min(1).describe('Events this rule matches'),
        mode: z.enum(['deliver', 'mute']).optional().describe('deliver (default) or mute'),
      },
    },
    async ({ organizationId, channelId, scopeType, scopeId, events, mode }) => {
      const result = await client.post(`/organizations/${organizationId}/notification-rules`, {
        channelId,
        scopeType,
        scopeId: scopeId ?? null,
        events,
        mode: mode ?? 'deliver',
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_notification_rule',
    {
      description: `Change a rule's events, mode, or enabled state. The scope and channel are fixed at creation; delete and recreate to move a rule.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        ruleId: z.string().describe('The notification rule UUID'),
        events: z.array(z.enum(EVENT_VALUES)).min(1).optional().describe('Replace matched events'),
        mode: z.enum(['deliver', 'mute']).optional().describe('deliver or mute'),
        enabled: z.boolean().optional().describe('false stops the rule matching'),
      },
    },
    async ({ organizationId, ruleId, events, mode, enabled }) => {
      const body: Record<string, unknown> = {};
      if (events !== undefined) body.events = events;
      if (mode !== undefined) body.mode = mode;
      if (enabled !== undefined) body.enabled = enabled;
      const result = await client.patch(`/organizations/${organizationId}/notification-rules/${ruleId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_notification_rule',
    {
      description: `Delete a notification rule. The channel it pointed at is left alone.`,
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        ruleId: z.string().describe('The notification rule UUID'),
      },
    },
    async ({ organizationId, ruleId }) => {
      const result = await client.delete(`/organizations/${organizationId}/notification-rules/${ruleId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'test_notification_channel',
    {
      description: `Send a test notification through a channel to verify it is wired up correctly. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
      },
    },
    async ({ organizationId, channelId }) => {
      const result = await client.post(`/organizations/${organizationId}/notification-channels/${channelId}/test`, {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'replay_notification_channel',
    {
      description: `Re-send everything a channel's rules would have matched over the last N hours. Use this after fixing a webhook that was down: the events were stored even though delivery failed. Only events the channel's own rules match are replayed. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
        sinceHours: z.number().min(1).max(72).optional().describe('How far back to replay, default 24'),
      },
    },
    async ({ organizationId, channelId, sinceHours }) => {
      const result = await client.post(
        `/organizations/${organizationId}/notification-channels/${channelId}/replay`,
        { sinceHours: sinceHours ?? 24 },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_notification_deliveries',
    {
      description: `List recent delivery attempts for a notification channel, including attempt count, HTTP status, errors, when the next retry is due, and whether messages were coalesced into a digest. This is the place to look when a channel isn't receiving alerts. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
      },
    },
    async ({ organizationId, channelId }) => {
      const result = await client.get(`/organizations/${organizationId}/notification-channels/${channelId}/deliveries`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
