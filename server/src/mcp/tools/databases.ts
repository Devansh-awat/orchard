import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerDatabaseTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_databases',
    {
      description: 'List all PostgreSQL databases in a project',
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const databases = await client.get(`/projects/${projectId}/databases`);
      return { content: [{ type: 'text', text: JSON.stringify(databases, null, 2) }] };
    },
  );

  server.registerTool(
    'get_database',
    {
      description: 'Get database details including connection information (host, port, user, password, database name)',
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
      },
    },
    async ({ databaseId }) => {
      const database = await client.get(`/databases/${databaseId}`);
      return { content: [{ type: 'text', text: JSON.stringify(database, null, 2) }] };
    },
  );

  server.registerTool(
    'create_database',
    {
      description: `Create a new PostgreSQL database in a project. Returns connection details.
After creating, you can use set_env_vars to set the DATABASE_URL on a deployment.
The DATABASE_URL format is: postgresql://user:password@host:port/dbname`,
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

  server.registerTool(
    'delete_database',
    {
      description: 'Delete a PostgreSQL database. WARNING: This permanently destroys all data in the database.',
      inputSchema: {
        databaseId: z.string().describe('The database UUID to delete'),
      },
    },
    async ({ databaseId }) => {
      await client.delete(`/databases/${databaseId}`);
      return { content: [{ type: 'text', text: 'Database deleted successfully.' }] };
    },
  );
}
