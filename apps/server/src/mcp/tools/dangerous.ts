import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path } from '../client';
import { failure, json, text } from './reply';

export function registerDangerousTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'delete_project',
    {
      description: `DANGEROUS and PERMANENT: Delete a project and ALL its deployments, databases (with their data and backups), ingresses, jobs and environments. Nothing is recoverable afterwards.

Confirm with the user first, then pass the project's exact name as confirmName; the server refuses the call otherwise.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID to delete'),
        confirmName: z
          .string()
          .describe('The exact project name, typed back to confirm the permanent deletion')
      }
    },
    async ({ projectId, confirmName }) => {
      const result = await client.delete(path`/projects/${projectId}`, { confirmName });
      return json(result);
    }
  );

  server.registerTool(
    'delete_deployment',
    {
      description: 'DANGEROUS: Delete a deployment and all associated resources.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID to delete')
      }
    },
    async ({ deploymentId }) => {
      await client.delete(path`/deployments/${deploymentId}`);
      return text('Deployment deleted successfully.');
    }
  );

  server.registerTool(
    'delete_environment',
    {
      description: `DANGEROUS: Delete an environment. This deletes its whole Kubernetes namespace, so every deployment, database, ingress and shared variable inside it goes with it. Databases in that environment are destroyed with their data.

List what is in it with \`list_deployments\` / \`list_databases\` and confirm with the user before calling, then pass the environment's exact name as confirmName; the server refuses the call otherwise. This is permanent. The default production environment cannot be deleted, and neither can the last environment in a project.`,
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID to delete'),
        confirmName: z
          .string()
          .describe('The exact environment name, typed back to confirm the permanent deletion')
      }
    },
    async ({ environmentId, confirmName }) => {
      const result = await client.delete(path`/environments/${environmentId}`, { confirmName });
      return json(result);
    }
  );

  server.registerTool(
    'delete_database',
    {
      description: `DANGEROUS: Delete a PostgreSQL database. Apps using it lose it immediately. The database goes to a 30-day trash: list it with list_deleted_databases and bring it back with undelete_database, as long as it had a completed backup (recoverableUntil in the response says how long). The server refuses the call while deletion protection is on.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID to delete')
      }
    },
    async ({ databaseId }) => {
      const result = await client.delete(path`/databases/${databaseId}`);
      return json(result);
    }
  );

  server.registerTool(
    'restore_database',
    {
      description: `DANGEROUS: Restore a database to an earlier state. Pick at most one target: backupId (from list_database_backups), checkpointId (from list_checkpoints), or at (an ISO time inside the recovery window, or "latest"). With no target it restores the latest recoverable point.

mode "in_place" (the default) replaces the current data. Orchard takes a checkpoint first and keeps the previous copy stopped for 24h, so undo_database_restore can swap it back. mode "fork" restores into a new database and leaves the original untouched; pass name and environmentId to place it.

Check the window with get_database_recovery_window first. Returns the operation; poll it with get_database_operation (wait: true) until it succeeds or fails.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID to restore'),
        backupId: z.guid().optional().describe('Restore from this backup'),
        checkpointId: z.guid().optional().describe('Restore to this checkpoint'),
        at: z
          .string()
          .optional()
          .describe('Point in time to restore to: an ISO 8601 timestamp, or "latest"'),
        mode: z
          .enum(['in_place', 'fork'])
          .optional()
          .describe('"in_place" (default) replaces the data, "fork" makes a new database'),
        name: z.string().optional().describe('Name for the new database when mode is "fork"'),
        environmentId: z
          .guid()
          .optional()
          .describe('Environment for the new database when mode is "fork"')
      }
    },
    async ({ databaseId, backupId, checkpointId, at, mode, name, environmentId }) => {
      const targets = [backupId, checkpointId, at].filter((value) => value !== undefined);
      if (targets.length > 1) {
        return failure('Error: Pass at most one of backupId, checkpointId or at.');
      }
      const body: Record<string, unknown> = {};
      if (backupId) body.backupId = backupId;
      if (checkpointId) body.checkpointId = checkpointId;
      if (at) body.at = at;
      if (mode) body.mode = mode;
      if (name) body.name = name;
      if (environmentId) body.environmentId = environmentId;
      const operation = await client.post(path`/databases/${databaseId}/restore`, body);
      return json(operation);
    }
  );

  server.registerTool(
    'restore_checkpoint',
    {
      description: `DANGEROUS: Restore to a checkpoint. Pass checkpointId for one database, or groupId to restore every database pinned together by a bulk create_checkpoint call.

mode "in_place" (the default) replaces the current data. Orchard checkpoints first and keeps the previous copy for 24h, so undo_database_restore can swap it back. mode "fork" restores into a new database and leaves the original untouched; name and environmentId only apply to a single checkpoint.

Only checkpoints with status "durable" can be restored. Returns the operation (an array of them for a group); poll each with get_database_operation.`,
      inputSchema: {
        checkpointId: z.guid().optional().describe('The checkpoint UUID (from list_checkpoints)'),
        groupId: z
          .guid()
          .optional()
          .describe('The checkpoint group UUID returned by a bulk create_checkpoint'),
        mode: z
          .enum(['in_place', 'fork'])
          .optional()
          .describe('"in_place" (default) replaces the data, "fork" makes new databases'),
        name: z.string().optional().describe('Name for the new database when mode is "fork"'),
        environmentId: z
          .guid()
          .optional()
          .describe('Environment for the new database when mode is "fork"')
      }
    },
    async ({ checkpointId, groupId, mode, name, environmentId }) => {
      if (Boolean(checkpointId) === Boolean(groupId)) {
        return failure('Error: Pass exactly one of checkpointId or groupId.');
      }
      if (groupId) {
        const operations = await client.post(path`/checkpoints/groups/${groupId}/restore`, {
          ...(mode ? { mode } : {})
        });
        return json(operations);
      }
      const body: Record<string, unknown> = {};
      if (mode) body.mode = mode;
      if (name) body.name = name;
      if (environmentId) body.environmentId = environmentId;
      const operation = await client.post(path`/checkpoints/${checkpointId}/restore`, body);
      return json(operation);
    }
  );

  server.registerTool(
    'undo_database_restore',
    {
      description:
        'DANGEROUS: Undo an in-place restore by swapping the database back to the copy Orchard kept from just before it. Works within 24h of the restore. Anything written since the restore is lost. Pass the restore operation id; returns the new operation, poll it with get_database_operation.',
      inputSchema: {
        operationId: z.guid().describe('The in-place restore operation UUID')
      }
    },
    async ({ operationId }) => {
      const operation = await client.post(path`/database-operations/${operationId}/undo`);
      return json(operation);
    }
  );

  server.registerTool(
    'disable_database_deletion_protection',
    {
      description:
        'DANGEROUS: Turn off deletion protection on a database so delete_database is allowed. Confirm with the user first. Turn it back on with set_database_protection.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.patch(path`/databases/${databaseId}/protection`, {
        deletionProtection: false
      });
      return json(result);
    }
  );

  server.registerTool(
    'delete_ingress',
    {
      description:
        'DANGEROUS: Delete an ingress (remove public access via a domain). Provide either deploymentId or projectId.',
      inputSchema: {
        deploymentId: z
          .guid()
          .optional()
          .describe('The deployment UUID (if ingress is linked to a deployment)'),
        projectId: z
          .guid()
          .optional()
          .describe('The project UUID (if ingress is not linked to a deployment)'),
        ingressId: z.guid().describe('The ingress UUID to delete')
      }
    },
    async ({ deploymentId, projectId, ingressId }) => {
      if (deploymentId) {
        await client.delete(path`/deployments/${deploymentId}/ingresses/${ingressId}`);
      } else if (projectId) {
        await client.delete(path`/projects/${projectId}/ingresses/${ingressId}`);
      } else {
        return failure('Error: Either deploymentId or projectId must be provided.');
      }
      return text('Ingress deleted successfully.');
    }
  );

  server.registerTool(
    'delete_service',
    {
      description: 'DANGEROUS: Delete a service from a deployment.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        serviceId: z.guid().describe('The service UUID to delete')
      }
    },
    async ({ deploymentId, serviceId }) => {
      await client.delete(path`/deployments/${deploymentId}/services/${serviceId}`);
      return text('Service deleted successfully.');
    }
  );

  server.registerTool(
    'delete_template',
    {
      description: 'DANGEROUS: Delete a custom template. Built-in templates cannot be deleted.',
      inputSchema: {
        templateId: z.guid().describe('The template UUID to delete')
      }
    },
    async ({ templateId }) => {
      await client.delete(path`/templates/${templateId}`);
      return text('Template deleted successfully.');
    }
  );

  server.registerTool(
    'delete_template_instance',
    {
      description:
        'DANGEROUS: Delete a template instance and ALL its associated resources (deployments, databases, ingresses).',
      inputSchema: {
        instanceId: z.guid().describe('The template instance UUID to delete')
      }
    },
    async ({ instanceId }) => {
      const result = await client.delete(path`/template-instances/${instanceId}`);
      return json(result);
    }
  );

  server.registerTool(
    'delete_env_vars',
    {
      description: `Remove specific environment variables from a deployment by key name, leaving every other var alone. The deployment restarts.

Only the keys you name are touched, so this is safe to use for a targeted removal — it is filed here because deleting a var an app reads will break it. To change a value instead of removing it, use \`add_env_vars\`.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        keys: z.array(z.string()).describe('Array of environment variable names to delete')
      }
    },
    async ({ deploymentId, keys }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
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

      const result = await client.put(path`/deployments/${deploymentId}/env`, { env: filtered });
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
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        tokenId: z.guid().describe('The webhook token UUID (from list_deploy_webhook_tokens)')
      }
    },
    async ({ deploymentId, tokenId }) => {
      const result = await client.delete(
        path`/deployments/${deploymentId}/webhook-tokens/${tokenId}`
      );
      return json(result);
    }
  );

  server.registerTool(
    'delete_notification_channel',
    {
      description: `DANGEROUS: Permanently delete a notification channel, along with every rule that routes to it. Alerts stop immediately and a webhook channel's signing secret is lost. Requires admin on the scope that owns the channel: org admin for org-wide destinations, project admin for one an app owns.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        channelId: z.guid().describe('The notification channel UUID')
      }
    },
    async ({ organizationId, channelId }) => {
      const result = await client.delete(
        path`/organizations/${organizationId}/notification-channels/${channelId}`
      );
      return json(result);
    }
  );
}
