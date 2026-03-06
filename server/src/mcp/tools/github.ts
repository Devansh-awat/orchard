import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerGitHubTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_github_status',
    {
      description: 'Check if the user\'s GitHub account is linked to Orchard. Required before deploying from GitHub repos.',
      inputSchema: {},
    },
    async () => {
      const status = await client.get('/github/status');
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    'list_github_repos',
    {
      description: 'List the user\'s GitHub repositories available for deployment',
      inputSchema: {},
    },
    async () => {
      const repos = await client.get('/github/repositories');
      return { content: [{ type: 'text', text: JSON.stringify(repos, null, 2) }] };
    },
  );

  server.registerTool(
    'list_github_app_repos',
    {
      description: 'List repositories from GitHub App installations (these have webhook support for auto-deploy)',
      inputSchema: {},
    },
    async () => {
      const repos = await client.get('/github/app/repositories');
      return { content: [{ type: 'text', text: JSON.stringify(repos, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_branches',
    {
      description: 'Get branches for a GitHub repository',
      inputSchema: {
        owner: z.string().describe('Repository owner (GitHub username or org)'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const branches = await client.get(`/github/repositories/${owner}/${repo}/branches`);
      return { content: [{ type: 'text', text: JSON.stringify(branches, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_dockerfiles',
    {
      description: 'Find Dockerfiles in a GitHub repository. Useful to determine if a repo can be deployed and which Dockerfile to use.',
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const dockerfiles = await client.get(`/github/repositories/${owner}/${repo}/dockerfiles`);
      return { content: [{ type: 'text', text: JSON.stringify(dockerfiles, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_contents',
    {
      description: 'Get the file/directory listing of a GitHub repository. Useful to analyze what the app needs.',
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const contents = await client.get(`/github/repositories/${owner}/${repo}/contents`);
      return { content: [{ type: 'text', text: JSON.stringify(contents, null, 2) }] };
    },
  );

  server.registerTool(
    'get_current_user',
    {
      description: 'Get the currently authenticated user\'s profile information',
      inputSchema: {},
    },
    async () => {
      const user = await client.get('/auth/me');
      return { content: [{ type: 'text', text: JSON.stringify(user, null, 2) }] };
    },
  );
}
