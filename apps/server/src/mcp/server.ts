import { McpServer } from '@modelcontextprotocol/server';
import { OrchardClient, type ActingUser, type McpScope } from './client';
import { catalogServer, parseToolsets, type ToolsetSelection } from './catalog';
import { registerQueryTools } from './tools/query';
import { registerDeploymentTools } from './tools/deployments';
import { registerConfigurationTools } from './tools/configuration';
import { registerResourceTools } from './tools/resources';
import { registerNotificationTools } from './tools/notifications';
import { registerJobTools } from './tools/jobs';
import { registerEnvironmentTools } from './tools/environments';
import { registerDangerousTools } from './tools/dangerous';
import { registerRolloutTools } from './tools/rollout';
import { registerComposeTools } from './tools/compose';
import { registerDocResources } from './tools/docs';
import { createCompactMcpServer } from './compact/compact-server';
import { registerGraftMcpTools } from '../grafts/mcp';

export type McpMode = 'normal' | 'compact';

export interface OrchardMcpOptions {
  token?: string;
  actingUser?: ActingUser;
  scope?: McpScope;
  toolsets?: string | ToolsetSelection | null;
  mode?: McpMode;
}

export function orchardClientFor(options: OrchardMcpOptions = {}): OrchardClient {
  return options.token || options.actingUser
    ? new OrchardClient(process.env.ORCHARD_API_URL, options.token, options.actingUser)
    : new OrchardClient();
}

export function createOrchardMcpServer(options: OrchardMcpOptions = {}) {
  const client = orchardClientFor(options);
  const scope = options.scope ?? options.actingUser?.scope ?? 'exec';
  if (options.mode === 'compact') return createCompactMcpServer(client, scope);

  const server = new McpServer(
    {
      name: 'orchard',
      version: '1.0.0'
    },
    { capabilities: { tools: {}, resources: {} } }
  );

  const requested = options.toolsets;
  const selection: ToolsetSelection =
    typeof requested === 'string' || requested == null
      ? parseToolsets(typeof requested === 'string' ? requested : process.env.ORCHARD_MCP_TOOLSETS)
      : requested;
  const tools = catalogServer(server, { selection, scope });

  registerQueryTools(tools, client);
  registerDeploymentTools(tools, client);
  registerRolloutTools(tools, client);
  registerComposeTools(tools, client);
  registerConfigurationTools(tools, client);
  registerResourceTools(tools, client);
  registerNotificationTools(tools, client);
  registerJobTools(tools, client);
  registerEnvironmentTools(tools, client);
  registerDangerousTools(tools, client);
  registerDocResources(server);

  registerGraftMcpTools(
    server,
    client,
    (graftId) => selection.allGrafts || selection.grafts.has(graftId)
  );

  return server;
}
