import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerWorkspaceTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_workspaces',
    {
      description: 'List all workspaces the authenticated user has access to',
      inputSchema: {},
    },
    async () => {
      const workspaces = await client.get('/workspaces');
      return { content: [{ type: 'text', text: JSON.stringify(workspaces, null, 2) }] };
    },
  );

  server.registerTool(
    'get_workspace',
    {
      description: 'Get workspace details by ID',
      inputSchema: {
        workspaceId: z.string().describe('The workspace UUID'),
      },
    },
    async ({ workspaceId }) => {
      const workspace = await client.get(`/workspaces/${workspaceId}`);
      return { content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }] };
    },
  );

  server.registerTool(
    'get_workspace_by_slug',
    {
      description: 'Get workspace details by slug',
      inputSchema: {
        slug: z.string().describe('The workspace slug'),
      },
    },
    async ({ slug }) => {
      const workspace = await client.get(`/workspaces/slug/${slug}`);
      return { content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }] };
    },
  );

  server.registerTool(
    'create_workspace',
    {
      description: 'Create a new workspace in an organization',
      inputSchema: {
        name: z.string().describe('Workspace name'),
        organizationId: z.string().describe('Organization UUID to create the workspace in'),
        description: z.string().optional().describe('Workspace description'),
      },
    },
    async ({ name, organizationId, description }) => {
      const workspace = await client.post('/workspaces', { name, organizationId, description });
      return { content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_workspace',
    {
      description: 'Delete a workspace. WARNING: This will delete all projects and deployments in the workspace.',
      inputSchema: {
        workspaceId: z.string().describe('The workspace UUID to delete'),
      },
    },
    async ({ workspaceId }) => {
      await client.delete(`/workspaces/${workspaceId}`);
      return { content: [{ type: 'text', text: 'Workspace deleted successfully.' }] };
    },
  );

  server.registerTool(
    'list_organizations',
    {
      description: 'List all organizations the authenticated user belongs to',
      inputSchema: {},
    },
    async () => {
      const orgs = await client.get('/organizations');
      return { content: [{ type: 'text', text: JSON.stringify(orgs, null, 2) }] };
    },
  );
}
