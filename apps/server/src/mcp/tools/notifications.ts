import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

const EVENT_VALUES = [
  'deploy.succeeded',
  'deploy.failed',
  'pod.crashing',
  'pod.recovered',
  'backup.completed',
  'backup.failed',
] as const;

export function registerNotificationTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_notification_channels',
    {
      description: `List an organization's notification channels (Discord, Slack, email, or webhook) with their subscribed events, project scope, and last delivery status. Requires org admin.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
      },
    },
    async ({ organizationId }) => {
      const result = await client.get(`/organizations/${organizationId}/notification-channels`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'create_notification_channel',
    {
      description: `Create a notification channel that sends deploy, crash, and backup alerts to Discord, Slack, email, or a generic webhook. Requires org admin.
For discord/slack/webhook, pass the webhook URL in "url". For email, pass "recipients" (must be members of the organization).
Omit projectIds to receive events for all projects in the org.
For webhook channels the response includes a one-time signing secret — surface it to the user, it cannot be retrieved again.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        type: z.enum(['discord', 'slack', 'webhook', 'email']).describe('Channel type'),
        name: z.string().max(100).describe('Display name, e.g. "#deploys"'),
        events: z.array(z.enum(EVENT_VALUES)).min(1).describe('Events to subscribe to'),
        url: z.string().optional().describe('Webhook URL (discord/slack/webhook types)'),
        recipients: z.array(z.string()).optional().describe('Email recipients (email type, org members only)'),
        projectIds: z.array(z.string()).optional().describe('Limit to specific project UUIDs; omit for all projects'),
      },
    },
    async ({ organizationId, type, name, events, url, recipients, projectIds }) => {
      const result = await client.post(`/organizations/${organizationId}/notification-channels`, {
        type,
        name,
        events,
        config: type === 'email' ? { recipients: recipients ?? [] } : { url },
        projectIds: projectIds ?? null,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_notification_channel',
    {
      description: `Update a notification channel's name, events, project scope, webhook URL, email recipients, or enabled state (enabled=false pauses delivery). Only provided fields change; the channel type cannot be changed. Requires org admin.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
        name: z.string().max(100).optional().describe('New display name'),
        events: z.array(z.enum(EVENT_VALUES)).min(1).optional().describe('Replace subscribed events'),
        url: z.string().optional().describe('New webhook URL (keeps the existing signing secret)'),
        recipients: z.array(z.string()).optional().describe('Replace email recipients'),
        projectIds: z.array(z.string()).nullable().optional().describe('Limit to project UUIDs, or null for all projects'),
        enabled: z.boolean().optional().describe('false pauses the channel, true resumes it'),
      },
    },
    async ({ organizationId, channelId, name, events, url, recipients, projectIds, enabled }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (events !== undefined) body.events = events;
      if (projectIds !== undefined) body.projectIds = projectIds;
      if (enabled !== undefined) body.enabled = enabled;
      if (url !== undefined || recipients !== undefined) {
        body.config = { ...(url !== undefined ? { url } : {}), ...(recipients !== undefined ? { recipients } : {}) };
      }
      const result = await client.patch(`/organizations/${organizationId}/notification-channels/${channelId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'test_notification_channel',
    {
      description: `Send a test notification through a channel to verify it is wired up correctly. Requires org admin.`,
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
    'list_notification_deliveries',
    {
      description: `List recent delivery attempts for a notification channel, including status and errors. Useful for debugging a channel that isn't receiving alerts. Requires org admin.`,
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
