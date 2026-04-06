import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerResourceTools(server: McpServer, client: OrchardClient) {
  // ── Projects ──────────────────────────────────────────────────────

  server.registerTool(
    'create_project',
    {
      description: 'Create a new project in an organization. A project groups deployments, databases, and networking.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('Organization UUID to create the project in'),
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description'),
      },
    },
    async ({ organizationId, name, description }) => {
      const project = await client.post('/projects', { organizationId, name, description });
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  // ── Databases ─────────────────────────────────────────────────────

  server.registerTool(
    'create_database',
    {
      description: `Create a new PostgreSQL database in a project. Returns connection details.
After creating, you can use set_env_vars to set the DATABASE_URL on a deployment.
The DATABASE_URL format is: postgresql://user:password@host:port/dbname`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Database display name'),
      },
    },
    async ({ projectId, name }) => {
      const database = await client.post(`/projects/${projectId}/databases`, { name });
      return { content: [{ type: 'text', text: JSON.stringify(database, null, 2) }] };
    },
  );

  // ── Templates ─────────────────────────────────────────────────────

  server.registerTool(
    'create_template',
    {
      description: 'Create a custom template from a YAML definition. Use get_template_yaml_guide to see the full format specification.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        yaml: z.string().describe('The full YAML template definition following the leaf/v1 format'),
      },
    },
    async ({ yaml }) => {
      const template = await client.post('/templates', { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    },
  );

  server.registerTool(
    'update_template',
    {
      description: 'Update an existing custom template with a new YAML definition. Built-in templates cannot be updated.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        templateId: z.string().describe('The template UUID to update'),
        yaml: z.string().describe('The updated YAML template definition'),
      },
    },
    async ({ templateId, yaml }) => {
      const template = await client.put(`/templates/${templateId}`, { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    },
  );

  server.registerTool(
    'deploy_template',
    {
      description: `Deploy a template to a project. This creates all the resources defined in the template (databases, deployments, ingresses) with the provided parameter values.

Before using this tool:
1. Use list_templates to find available templates
2. Use get_template to see the required parameters
3. Provide all required parameters as a JSON object

The template engine will validate parameters and create resources in order, wiring them together automatically (e.g. DATABASE_URL is set on the deployment from the created database).`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID to deploy the template into'),
        templateId: z.string().describe('The template UUID to deploy'),
        parameters: z.record(z.any()).describe('Parameter values as a JSON object, e.g. { "appName": "my-app", "image": "nginx:latest", "port": 3000 }'),
      },
    },
    async ({ projectId, templateId, parameters }) => {
      const instance = await client.post(`/projects/${projectId}/template-instances`, {
        templateId,
        parameters,
      });
      return { content: [{ type: 'text', text: JSON.stringify(instance, null, 2) }] };
    },
  );
}
