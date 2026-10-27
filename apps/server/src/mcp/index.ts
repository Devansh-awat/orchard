import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createOrchardMcpServer } from './server';

const mode = process.env.ORCHARD_MCP_MODE === 'compact' ? 'compact' : 'normal';

serveStdio(() =>
  createOrchardMcpServer({ mode, toolsets: process.env.ORCHARD_MCP_TOOLSETS ?? null })
);
console.error(`Orchard MCP Server running on stdio (${mode})`);
