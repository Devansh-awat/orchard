import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerDeploymentTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'create_deployment',
    {
      description: `Create a new deployment from a Docker image in a project.
This also creates an internal ClusterIP service targeting the specified port.
If no port is specified, it defaults to 80. Make sure the port matches the port your container listens on.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        image: z.string().describe('Docker image (e.g. nginx:latest, ghcr.io/user/app:v1)'),
        replicas: z.number().optional().describe('Number of replicas (default: 1)'),
        port: z.number().optional().describe('Port the container listens on (default: 80). The created service will target this port.'),
        env: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
        })).optional().describe('Environment variables to set on the deployment'),
      },
    },
    async ({ projectId, name, image, replicas, port, env }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments`, {
        name,
        image,
        replicas: replicas ?? 1,
        ...(port && { port }),
        ...(env && { env }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    },
  );

  server.registerTool(
    'deploy_from_github',
    {
      description: `Deploy an application from a GitHub repository. This will build the Docker image from the repo and deploy it.
Before using this tool:
- Check if the user's GitHub account is linked using get_github_status
- If not linked, tell the user to link their GitHub account first via the Orchard UI
- Ask the user about environment variables their app needs
- Ask if the app needs a database (use create_database tool)
- Ask if the app needs a public domain (use create_ingress tool after deployment)
- If the repo needs additional services like Redis, inform the user
- IMPORTANT: If no port is specified, the server will try to auto-detect the port from the Dockerfile's EXPOSE directive. If the Dockerfile has no EXPOSE directive, it defaults to port 80. If you are unsure about the port, check the Dockerfile first using get_repo_contents or ask the user what port their app listens on.
- If the Dockerfile copies files from the repo root (e.g. pnpm-workspace.yaml, package.json), set buildFromRoot to true`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        githubRepo: z.string().describe('GitHub repository in owner/repo format (e.g. user/my-app)'),
        branch: z.string().optional().describe('Branch to deploy from (default: main)'),
        dockerfilePath: z.string().optional().describe('Path to Dockerfile relative to repo root (default: Dockerfile)'),
        buildFromRoot: z.boolean().optional().describe('Whether to use repo root as build context (default: false)'),
        port: z.number().optional().describe('Port the application listens on. If not specified, auto-detected from Dockerfile EXPOSE directive, falling back to 80'),
        env: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
        })).optional().describe('Environment variables to set on the deployment'),
      },
    },
    async ({ projectId, name, githubRepo, branch, dockerfilePath, buildFromRoot, port, env }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments/from-github`, {
        name,
        githubRepo,
        branch: branch ?? 'main',
        dockerfilePath,
        buildFromRoot: buildFromRoot ?? false,
        ...(port && { port }),
        ...(env && { env }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    },
  );

  server.registerTool(
    'restart_deployment',
    {
      description: 'Restart a deployment (rolling restart of all pods)',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to restart'),
      },
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/restart`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'rebuild_deployment',
    {
      description: 'Rebuild a deployment from source (triggers a new build from the GitHub repo)',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to rebuild'),
      },
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/rebuild`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'scale_deployment',
    {
      description: 'Scale a deployment to a specific number of replicas',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        replicas: z.number().min(0).max(10).describe('Number of replicas (0 to pause, max 10)'),
      },
    },
    async ({ deploymentId, replicas }) => {
      const result = await client.post(`/deployments/${deploymentId}/scale`, { replicas });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'rollback_deployment',
    {
      description: 'Rollback a deployment to a previous image version. Use get_image_history to see available versions.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        imageHistoryId: z.string().describe('The image history entry UUID to rollback to'),
      },
    },
    async ({ deploymentId, imageHistoryId }) => {
      const result = await client.post(`/deployments/${deploymentId}/rollback/${imageHistoryId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'cancel_build',
    {
      description: 'Cancel an in-progress build for a deployment',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/cancel`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'enable_auto_deploy',
    {
      description: 'Enable auto-deploy for a deployment. When enabled, pushes to the configured branch will automatically trigger a rebuild.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        branch: z.string().describe('The branch to auto-deploy from (e.g. main)'),
      },
    },
    async ({ deploymentId, branch }) => {
      const result = await client.post(`/deployments/${deploymentId}/auto-deploy/enable`, { branch });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'disable_auto_deploy',
    {
      description: 'Disable auto-deploy for a deployment',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/auto-deploy/disable`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
