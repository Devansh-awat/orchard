import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';

export function registerDangerousTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'delete_project',
    {
      description: 'DANGEROUS: Delete a project and ALL its deployments, databases, and ingresses.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID to delete'),
      },
    },
    async ({ projectId }) => {
      await client.delete(`/projects/${projectId}`);
      return { content: [{ type: 'text', text: 'Project deleted successfully.' }] };
    },
  );

  server.registerTool(
    'delete_deployment',
    {
      description: 'DANGEROUS: Delete a deployment and all associated resources.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to delete'),
      },
    },
    async ({ deploymentId }) => {
      await client.delete(`/deployments/${deploymentId}`);
      return { content: [{ type: 'text', text: 'Deployment deleted successfully.' }] };
    },
  );

  server.registerTool(
    'delete_database',
    {
      description: 'DANGEROUS: Delete a PostgreSQL database. This permanently destroys all data.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID to delete'),
      },
    },
    async ({ databaseId }) => {
      await client.delete(`/databases/${databaseId}`);
      return { content: [{ type: 'text', text: 'Database deleted successfully.' }] };
    },
  );

  server.registerTool(
    'restore_database_backup',
    {
      description: `DANGEROUS: Restore a database from a previous backup. This REPLACES all current data in the database with the backup's contents. Use list_database_backups to find a backupId.`,
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID to restore into'),
        backupId: z
          .string()
          .optional()
          .describe(
            'The backup UUID to restore from. If omitted, the server restores from the latest available backup.',
          ),
      },
    },
    async ({ databaseId, backupId }) => {
      const body: Record<string, unknown> = {};
      if (backupId) body.backupId = backupId;
      const result = await client.post(`/databases/${databaseId}/restore`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_ingress',
    {
      description: 'DANGEROUS: Delete an ingress (remove public access via a domain). Provide either deploymentId or projectId.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().optional().describe('The deployment UUID (if ingress is linked to a deployment)'),
        projectId: z.string().optional().describe('The project UUID (if ingress is not linked to a deployment)'),
        ingressId: z.string().describe('The ingress UUID to delete'),
      },
    },
    async ({ deploymentId, projectId, ingressId }) => {
      if (deploymentId) {
        await client.delete(`/deployments/${deploymentId}/ingresses/${ingressId}`);
      } else if (projectId) {
        await client.delete(`/projects/${projectId}/ingresses/${ingressId}`);
      } else {
        return { content: [{ type: 'text', text: 'Error: Either deploymentId or projectId must be provided.' }] };
      }
      return { content: [{ type: 'text', text: 'Ingress deleted successfully.' }] };
    },
  );

  server.registerTool(
    'delete_service',
    {
      description: 'DANGEROUS: Delete a service from a deployment.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        serviceId: z.string().describe('The service UUID to delete'),
      },
    },
    async ({ deploymentId, serviceId }) => {
      await client.delete(`/deployments/${deploymentId}/services/${serviceId}`);
      return { content: [{ type: 'text', text: 'Service deleted successfully.' }] };
    },
  );

  server.registerTool(
    'delete_template',
    {
      description: 'DANGEROUS: Delete a custom template. Built-in templates cannot be deleted.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        templateId: z.string().describe('The template UUID to delete'),
      },
    },
    async ({ templateId }) => {
      await client.delete(`/templates/${templateId}`);
      return { content: [{ type: 'text', text: 'Template deleted successfully.' }] };
    },
  );

  server.registerTool(
    'delete_template_instance',
    {
      description: 'DANGEROUS: Delete a template instance and ALL its associated resources (deployments, databases, ingresses).',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        instanceId: z.string().describe('The template instance UUID to delete'),
      },
    },
    async ({ instanceId }) => {
      const result = await client.delete(`/template-instances/${instanceId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_env_vars',
    {
      description: `DANGEROUS: Delete specific environment variables from a deployment by key name. The deployment will restart.`,
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        keys: z.array(z.string()).describe('Array of environment variable names to delete'),
      },
    },
    async ({ deploymentId, keys }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const existing: { key: string; value: string }[] = (deployment.envVars || []).map(
        (v: { key: string; value: string }) => ({ key: v.key, value: v.value }),
      );

      const keysToDelete = new Set(keys);
      const filtered = existing.filter((v) => !keysToDelete.has(v.key));

      const removed = keys.filter((k) => existing.some((v) => v.key === k));
      const notFound = keys.filter((k) => !existing.some((v) => v.key === k));

      const result = await client.put(`/deployments/${deploymentId}/env`, { env: filtered });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            removed,
            notFound: notFound.length > 0 ? notFound : undefined,
            deployment: result,
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'delete_notification_channel',
    {
      description: `DANGEROUS: Permanently delete a notification channel, along with every rule that routes to it. Alerts stop immediately and a webhook channel's signing secret is lost. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { destructiveHint: true, readOnlyHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID'),
      },
    },
    async ({ organizationId, channelId }) => {
      const result = await client.delete(`/organizations/${organizationId}/notification-channels/${channelId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
