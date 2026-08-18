import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createOrchardMcpServer } from './server';

// serveStdio drives the 2026-07-28 protocol over stdio and, by default, also
// serves a 2025-era client that opens with the legacy `initialize` handshake
// (options.legacy = 'serve'). The factory has no per-connection auth — the
// local CLI authenticates to the Orchard API via the ORCHARD_API_TOKEN env.
serveStdio(() => createOrchardMcpServer());
console.error('Orchard MCP Server running on stdio');
