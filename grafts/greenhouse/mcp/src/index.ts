import type { McpServer } from '@modelcontextprotocol/server';
import { defineMcp } from '@orchard/graft-sdk/server';
import { registerSandboxTools } from './tools';

export default defineMcp((server, client) =>
  registerSandboxTools(server as unknown as McpServer, client)
);
