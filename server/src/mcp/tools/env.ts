import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerEnvTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_env_vars',
    {
      description: 'Get the current environment variables for a deployment',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const envVars = deployment.envVars || [];
      return { content: [{ type: 'text', text: JSON.stringify(envVars, null, 2) }] };
    },
  );

  server.registerTool(
    'set_env_vars',
    {
      description: `Set or update environment variables on a deployment. This will restart the deployment to apply changes.
Provide the full list of env vars — any existing vars not included will be removed.
Common env vars to suggest: DATABASE_URL (if using a database), PORT, NODE_ENV, etc.`,
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        envVars: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
        })).describe('Array of environment variable key-value pairs'),
      },
    },
    async ({ deploymentId, envVars }) => {
      const result = await client.put(`/deployments/${deploymentId}/env`, { env: envVars });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'add_env_vars',
    {
      description: `Add or update specific environment variables on a deployment without affecting other existing vars.
This fetches the current env vars, merges in the provided ones (overwriting any with the same key), and applies the result. The deployment will restart.`,
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        envVars: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
        })).describe('Array of environment variable key-value pairs to add or update'),
      },
    },
    async ({ deploymentId, envVars }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const existing: { key: string; value: string }[] = (deployment.envVars || []).map(
        (v: { key: string; value: string }) => ({ key: v.key, value: v.value }),
      );

      const newKeys = new Set(envVars.map((v) => v.key));
      const merged = [
        ...existing.filter((v) => !newKeys.has(v.key)),
        ...envVars,
      ];

      const result = await client.put(`/deployments/${deploymentId}/env`, { env: merged });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_env_vars',
    {
      description: `Delete specific environment variables from a deployment by key name.
This fetches the current env vars, removes the specified keys, and applies the result. The deployment will restart.`,
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
}
