import { McpServer } from '@modelcontextprotocol/server';
import { OrchardClient, type ActingUser } from './client';
import { registerQueryTools } from './tools/query';
import { registerDeploymentTools } from './tools/deployments';
import { registerConfigurationTools } from './tools/configuration';
import { registerResourceTools } from './tools/resources';
import { registerNotificationTools } from './tools/notifications';
import { registerJobTools } from './tools/jobs';
import { registerEnvironmentTools } from './tools/environments';
import { registerDangerousTools } from './tools/dangerous';
import { registerSandboxTools } from './tools/sandboxes';

export function createOrchardMcpServer(token?: string, actingUser?: ActingUser) {
  const server = new McpServer(
    {
      name: 'orchard',
      version: '1.0.0'
    },
    { capabilities: { tools: {} } }
  );

  const client =
    token || actingUser
      ? new OrchardClient(process.env.ORCHARD_API_URL, token, actingUser)
      : new OrchardClient();

  // Read-only queries (list, get, inspect)
  registerQueryTools(server, client);

  // Deployment lifecycle (create, restart, rebuild, scale, rollback, auto-deploy)
  registerDeploymentTools(server, client);

  // Configuration (env vars, volumes, networking create/update)
  registerConfigurationTools(server, client);

  // Resource creation (projects, databases, templates)
  registerResourceTools(server, client);

  // Notification channels (list, create, update, test, deliveries)
  registerNotificationTools(server, client);

  // Jobs (scheduled/on-demand pipelines: CRUD, run, history, logs)
  registerJobTools(server, client);

  // Environments (namespaces per project) and their shared variables
  registerEnvironmentTools(server, client);

  registerSandboxTools(server, client);

  // Destructive operations (all deletes)
  registerDangerousTools(server, client);

  return server;
}
