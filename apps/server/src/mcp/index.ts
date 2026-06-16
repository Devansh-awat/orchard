import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOrchardMcpServer } from './server';

async function main() {
  const server = createOrchardMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Orchard MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
