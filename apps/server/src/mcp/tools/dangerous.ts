import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';
import { json, text } from './reply';

export function registerDangerousTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'delete_project',
    {
      description: `DANGEROUS and PERMANENT: Delete a project and ALL its deployments, databases (with their data and backups), ingresses, jobs and environments. Nothing is recoverable afterwards.

Confirm with the user first, then pass the project's exact name as confirmName; the server refuses the call otherwise.`,
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID to delete'),
        confirmName: z
          .string()
          .describe('The exact project name, typed back to confirm the permanent deletion')
      }
    },
    async ({ projectId, confirmName }) => {
      const result = await client.delete(`/projects/${projectId}`, { confirmName });
      return json(result);
    }
  );

  server.registerTool(
    'delete_deployment',
    {
      description: 'DANGEROUS: Delete a deployment and all associated resources.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to delete')
      }
    },
    async ({ deploymentId }) => {
      await client.delete(`/deployments/${deploymentId}`);
      return text('Deployment deleted successfully.');
    }
  );

  server.registerTool(
    'delete_environment',
    {
      description: `DANGEROUS: Delete an environment. This deletes its whole Kubernetes namespace, so every deployment, database, ingress and shared variable inside it goes with it. Databases in that environment are destroyed with their data.

List what is in it with \`list_deployments\` / \`list_databases\` and confirm with the user before calling, then pass the environment's exact name as confirmName; the server refuses the call otherwise. This is permanent. The default production environment cannot be deleted, and neither can the last environment in a project.`,
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        environmentId: z.string().describe('The environment UUID to delete'),
        confirmName: z
          .string()
          .describe('The exact environment name, typed back to confirm the permanent deletion')
      }
    },
    async ({ environmentId, confirmName }) => {
      const result = await client.delete(`/environments/${environmentId}`, { confirmName });
      return json(result);
    }
  );

  server.registerTool(
    'delete_database',
    {
      description: 'DANGEROUS: Delete a PostgreSQL database. This permanently destroys all data.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID to delete')
      }
    },
    async ({ databaseId }) => {
      await client.delete(`/databases/${databaseId}`);
      return text('Database deleted successfully.');
    }
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
            'The backup UUID to restore from. If omitted, the server restores from the latest available backup.'
          )
      }
    },
    async ({ databaseId, backupId }) => {
      const body: Record<string, unknown> = {};
      if (backupId) body.backupId = backupId;
      const result = await client.post(`/databases/${databaseId}/restore`, body);
      return json(result);
    }
  );

  server.registerTool(
    'delete_ingress',
    {
      description:
        'DANGEROUS: Delete an ingress (remove public access via a domain). Provide either deploymentId or projectId.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z
          .string()
          .optional()
          .describe('The deployment UUID (if ingress is linked to a deployment)'),
        projectId: z
          .string()
          .optional()
          .describe('The project UUID (if ingress is not linked to a deployment)'),
        ingressId: z.string().describe('The ingress UUID to delete')
      }
    },
    async ({ deploymentId, projectId, ingressId }) => {
      if (deploymentId) {
        await client.delete(`/deployments/${deploymentId}/ingresses/${ingressId}`);
      } else if (projectId) {
        await client.delete(`/projects/${projectId}/ingresses/${ingressId}`);
      } else {
        return {
          content: [
            { type: 'text', text: 'Error: Either deploymentId or projectId must be provided.' }
          ]
        };
      }
      return text('Ingress deleted successfully.');
    }
  );

  server.registerTool(
    'delete_service',
    {
      description: 'DANGEROUS: Delete a service from a deployment.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        serviceId: z.string().describe('The service UUID to delete')
      }
    },
    async ({ deploymentId, serviceId }) => {
      await client.delete(`/deployments/${deploymentId}/services/${serviceId}`);
      return text('Service deleted successfully.');
    }
  );

  server.registerTool(
    'delete_template',
    {
      description: 'DANGEROUS: Delete a custom template. Built-in templates cannot be deleted.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        templateId: z.string().describe('The template UUID to delete')
      }
    },
    async ({ templateId }) => {
      await client.delete(`/templates/${templateId}`);
      return text('Template deleted successfully.');
    }
  );

  server.registerTool(
    'delete_template_instance',
    {
      description:
        'DANGEROUS: Delete a template instance and ALL its associated resources (deployments, databases, ingresses).',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        instanceId: z.string().describe('The template instance UUID to delete')
      }
    },
    async ({ instanceId }) => {
      const result = await client.delete(`/template-instances/${instanceId}`);
      return json(result);
    }
  );

  server.registerTool(
    'delete_env_vars',
    {
      description: `Remove specific environment variables from a deployment by key name, leaving every other var alone. The deployment restarts.

Only the keys you name are touched, so this is safe to use for a targeted removal — it is filed here because deleting a var an app reads will break it. To change a value instead of removing it, use \`add_env_vars\`.`,
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        keys: z.array(z.string()).describe('Array of environment variable names to delete')
      }
    },
    async ({ deploymentId, keys }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      // A secret reads back with no value: keep its flag and send null so the
      // ones being kept are kept, not republished or blanked.
      const existing: { key: string; value: string | null; secret?: boolean }[] = (
        deployment.envVars || []
      ).map((v: { key: string; value: string | null; secret?: boolean }) => ({
        key: v.key,
        value: v.value ?? null,
        secret: v.secret
      }));

      const keysToDelete = new Set(keys);
      const filtered = existing.filter((v) => !keysToDelete.has(v.key));

      const removed = keys.filter((k) => existing.some((v) => v.key === k));
      const notFound = keys.filter((k) => !existing.some((v) => v.key === k));

      const result = await client.put(`/deployments/${deploymentId}/env`, { env: filtered });
      return json({
        removed,
        notFound: notFound.length > 0 ? notFound : undefined,
        deployment: result
      });
    }
  );

  server.registerTool(
    'delete_deploy_webhook_token',
    {
      description:
        'Revoke a deploy webhook token. Whatever CI is using it starts failing on its next run, so check `lastUsedAt` on `list_deploy_webhook_tokens` before revoking one you did not create.',
      annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        tokenId: z.string().describe('The webhook token UUID (from list_deploy_webhook_tokens)')
      }
    },
    async ({ deploymentId, tokenId }) => {
      const result = await client.delete(`/deployments/${deploymentId}/webhook-tokens/${tokenId}`);
      return json(result);
    }
  );

  server.registerTool(
    'delete_notification_channel',
    {
      description: `DANGEROUS: Permanently delete a notification channel, along with every rule that routes to it. Alerts stop immediately and a webhook channel's signing secret is lost. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      annotations: { destructiveHint: true, readOnlyHint: false },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
        channelId: z.string().describe('The notification channel UUID')
      }
    },
    async ({ organizationId, channelId }) => {
      const result = await client.delete(
        `/organizations/${organizationId}/notification-channels/${channelId}`
      );
      return json(result);
    }
  );
}
