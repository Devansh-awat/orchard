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
      const result = await client.put(`/deployments/${deploymentId}/env`, { envVars });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
