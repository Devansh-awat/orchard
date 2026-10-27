import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path } from '../client';
import { json, paginate } from './reply';
import { pageInput } from './inputs';

export function registerComposeTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_compose_stacks',
    {
      description: `List the Docker Compose stacks in a project. A stack owns several deployments created from one compose file in a GitHub repo; each entry carries its services and source.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        ...pageInput
      }
    },
    async ({ projectId, limit, cursor }) => {
      const stacks = await client.get(path`/projects/${projectId}/compose-stacks`);
      return json(Array.isArray(stacks) ? paginate(stacks, { limit, cursor }) : stacks);
    }
  );

  server.registerTool(
    'get_compose_stack',
    {
      description: `Get one compose stack: its repo, branch, compose file path, auto-deploy state and the deployments it manages.`,
      inputSchema: {
        stackId: z.guid().describe('The compose stack UUID (from list_compose_stacks)')
      }
    },
    async ({ stackId }) => {
      return json(await client.get(path`/compose-stacks/${stackId}`));
    }
  );

  server.registerTool(
    'redeploy_compose_stack',
    {
      description: `Re-read the compose file from the repo and redeploy every service in the stack. Services keep their domains and volumes; new services are added and the rest roll to the new build.`,
      inputSchema: {
        stackId: z.guid().describe('The compose stack UUID (from list_compose_stacks)')
      }
    },
    async ({ stackId }) => {
      return json(await client.post(path`/compose-stacks/${stackId}/redeploy`));
    }
  );
}
