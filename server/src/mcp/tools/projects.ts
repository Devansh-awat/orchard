import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerProjectTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_projects',
    {
      description: 'List all projects in a workspace',
      inputSchema: {
        workspaceId: z.string().describe('The workspace UUID'),
      },
    },
    async ({ workspaceId }) => {
      const projects = await client.get(`/workspaces/${workspaceId}/projects`);
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    },
  );

  server.registerTool(
    'get_project',
    {
      description: 'Get project details including deployments, databases, and ingresses',
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const project = await client.get(`/projects/${projectId}`);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.registerTool(
    'create_project',
    {
      description: 'Create a new project in a workspace. A project groups deployments, databases, and networking.',
      inputSchema: {
        workspaceId: z.string().describe('The workspace UUID'),
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description'),
      },
    },
    async ({ workspaceId, name, description }) => {
      const project = await client.post('/projects', { workspaceId, name, description });
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_project',
    {
      description: 'Delete a project. WARNING: This deletes all deployments, databases, and ingresses in the project.',
      inputSchema: {
        projectId: z.string().describe('The project UUID to delete'),
      },
    },
    async ({ projectId }) => {
      await client.delete(`/projects/${projectId}`);
      return { content: [{ type: 'text', text: 'Project deleted successfully.' }] };
    },
  );
}
