import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrchardClient } from './client';
import { registerWorkspaceTools } from './tools/workspaces';
import { registerProjectTools } from './tools/projects';
import { registerDeploymentTools } from './tools/deployments';
import { registerEnvTools } from './tools/env';
import { registerNetworkingTools } from './tools/networking';
import { registerDatabaseTools } from './tools/databases';
import { registerLogTools } from './tools/logs';
import { registerGitHubTools } from './tools/github';
import { registerTemplateTools } from './tools/templates';
import { registerVolumeTools } from './tools/volumes';

export function createOrchardMcpServer(token?: string) {
  const server = new McpServer({
    name: 'orchard',
    version: '1.0.0',
  });

  const client = token
    ? new OrchardClient(process.env.ORCHARD_API_URL, token)
    : new OrchardClient();

  registerWorkspaceTools(server, client);
  registerProjectTools(server, client);
  registerDeploymentTools(server, client);
  registerEnvTools(server, client);
  registerNetworkingTools(server, client);
  registerDatabaseTools(server, client);
  registerLogTools(server, client);
  registerGitHubTools(server, client);
  registerTemplateTools(server, client);
  registerVolumeTools(server, client);

  return server;
}
