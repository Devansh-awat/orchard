import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerNetworkingTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_ingresses',
    {
      description: 'List all ingresses (public domains/routes) for a project',
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const ingresses = await client.get(`/projects/${projectId}/ingresses`);
      return { content: [{ type: 'text', text: JSON.stringify(ingresses, null, 2) }] };
    },
  );

  server.registerTool(
    'get_ingress',
    {
      description: 'Get ingress details',
      inputSchema: {
        ingressId: z.string().describe('The ingress UUID'),
      },
    },
    async ({ ingressId }) => {
      const ingress = await client.get(`/ingresses/${ingressId}`);
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'create_ingress',
    {
      description: `Create a public ingress (domain route) for a deployment. This makes the deployment accessible via a domain name with automatic TLS.
The user must point their domain's DNS to the cluster before creating the ingress. Use validate_dns to check.`,
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        deploymentId: z.string().describe('The deployment UUID to route traffic to'),
        host: z.string().describe('The domain name (e.g. myapp.example.com)'),
        path: z.string().optional().describe('URL path prefix (default: /)'),
        servicePort: z.number().optional().describe('The service port to route to (default: 80)'),
      },
    },
    async ({ projectId, deploymentId, host, path, servicePort }) => {
      const ingress = await client.post(`/deployments/${deploymentId}/ingresses`, {
        projectId,
        host,
        path: path ?? '/',
        servicePort: servicePort ?? 80,
      });
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'update_ingress',
    {
      description: 'Update an existing ingress configuration',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        ingressId: z.string().describe('The ingress UUID to update'),
        host: z.string().optional().describe('New domain name'),
        path: z.string().optional().describe('New URL path prefix'),
      },
    },
    async ({ deploymentId, ingressId, host, path }) => {
      const body: any = {};
      if (host !== undefined) body.host = host;
      if (path !== undefined) body.path = path;
      const ingress = await client.put(`/deployments/${deploymentId}/ingresses/${ingressId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_ingress',
    {
      description: 'Delete an ingress (remove public access via a domain). Provide either deploymentId or projectId depending on whether the ingress is linked to a deployment.',
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
    'validate_dns',
    {
      description: 'Validate that a domain\'s DNS is correctly pointed to the Orchard cluster. Run this before creating an ingress.',
      inputSchema: {
        domain: z.string().describe('The domain to validate (e.g. myapp.example.com)'),
      },
    },
    async ({ domain }) => {
      const result = await client.post('/projects/ingresses/validate-dns', { domain });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_services',
    {
      description: 'List services for a deployment (internal networking, load balancers, etc.)',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const services = deployment.services || [];
      return { content: [{ type: 'text', text: JSON.stringify(services, null, 2) }] };
    },
  );

  server.registerTool(
    'create_service',
    {
      description: 'Create an internal or external service for a deployment to expose ports',
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        name: z.string().describe('Service name'),
        type: z.enum(['internal', 'external']).describe('Service type: internal (ClusterIP) or external (NodePort/LoadBalancer)'),
        port: z.number().describe('Service port'),
        targetPort: z.number().describe('Container port to route to'),
      },
    },
    async ({ deploymentId, name, type, port, targetPort }) => {
      const service = await client.post(`/deployments/${deploymentId}/services`, {
        name,
        type,
        port,
        targetPort,
      });
      return { content: [{ type: 'text', text: JSON.stringify(service, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_service',
    {
      description: 'Delete a service from a deployment',
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
}
