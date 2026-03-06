import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerDeploymentTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_deployments',
    {
      description: 'List all deployments in a project',
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const deployments = await client.get(`/projects/${projectId}/deployments`);
      return { content: [{ type: 'text', text: JSON.stringify(deployments, null, 2) }] };
    },
  );

  server.registerTool(
    'get_deployment',
    {
      description: 'Get deployment details including status, image, replicas, env vars, services, and ingresses',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    },
  );

  server.registerTool(
    'create_deployment',
    {
      description: 'Create a new deployment from a Docker image in a project',
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        image: z.string().describe('Docker image (e.g. nginx:latest, ghcr.io/user/app:v1)'),
        replicas: z.number().optional().describe('Number of replicas (default: 1)'),
      },
    },
    async ({ projectId, name, image, replicas }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments`, {
        name,
        image,
        replicas: replicas ?? 1,
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
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Deployment name'),
        githubRepo: z.string().describe('GitHub repository in owner/repo format (e.g. user/my-app)'),
        branch: z.string().optional().describe('Branch to deploy from (default: main)'),
        dockerfilePath: z.string().optional().describe('Path to Dockerfile relative to repo root (default: Dockerfile)'),
        buildFromRoot: z.boolean().optional().describe('Whether to use repo root as build context (default: false)'),
        port: z.number().optional().describe('Port the application listens on. If not specified, auto-detected from Dockerfile EXPOSE directive, falling back to 80'),
      },
    },
    async ({ projectId, name, githubRepo, branch, dockerfilePath, buildFromRoot, port }) => {
      const deployment = await client.post(`/projects/${projectId}/deployments/from-github`, {
        name,
        githubRepo,
        branch: branch ?? 'main',
        dockerfilePath,
        buildFromRoot: buildFromRoot ?? false,
        ...(port && { port }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_deployment',
    {
      description: 'Delete a deployment and all associated resources',
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
    'restart_deployment',
    {
      description: 'Restart a deployment (rolling restart of all pods)',
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
    'get_image_history',
    {
      description: 'Get the image version history for a deployment (for rollback purposes)',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const history = await client.get(`/deployments/${deploymentId}/image-history`);
      return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
    },
  );

  server.registerTool(
    'cancel_build',
    {
      description: 'Cancel an in-progress build for a deployment',
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
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const result = await client.post(`/deployments/${deploymentId}/auto-deploy/enable`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'disable_auto_deploy',
    {
      description: 'Disable auto-deploy for a deployment',
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
