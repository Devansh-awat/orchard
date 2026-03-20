import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerLogTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_build_logs',
    {
      description: 'Get the build logs for a deployment (Docker build output)',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const logs = await client.get(`/deployments/${deploymentId}/logs`);
      return { content: [{ type: 'text', text: typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2) }] };
    },
  );

  server.registerTool(
    'list_pods',
    {
      description: 'List all running pods for a deployment (each pod is a running instance). The response includes the namespace which you should pass to get_pod_logs.',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const [pods, deployment] = await Promise.all([
        client.get(`/deployments/${deploymentId}/pods`),
        client.get(`/deployments/${deploymentId}`),
      ]);
      const result = {
        namespace: deployment?.namespace,
        pods,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_pod_logs',
    {
      description: 'Get runtime logs from a specific pod. Use list_pods first to get pod names.',
      inputSchema: {
        podName: z.string().describe('The pod name (from list_pods)'),
        namespace: z.string().optional().describe('Kubernetes namespace (defaults to deployment namespace). Get this from the deployment details or list_pods.'),
        tailLines: z.number().optional().describe('Number of log lines to return (default: 100)'),
      },
    },
    async ({ podName, namespace, tailLines }) => {
      const params = new URLSearchParams();
      if (namespace) params.set('namespace', namespace);
      if (tailLines) params.set('tailLines', String(tailLines));
      const qs = params.toString();
      const logs = await client.get(`/pods/${podName}/logs${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2) }] };
    },
  );

  server.registerTool(
    'get_pod_details',
    {
      description: 'Get detailed information about a specific pod including status, IP, node, and restart count',
      inputSchema: {
        podName: z.string().describe('The pod name'),
      },
    },
    async ({ podName }) => {
      const pod = await client.get(`/pods/${podName}`);
      return { content: [{ type: 'text', text: JSON.stringify(pod, null, 2) }] };
    },
  );
}
