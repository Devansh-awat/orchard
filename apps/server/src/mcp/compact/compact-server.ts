import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import {
  findOperation,
  searchOperations,
  type AgentOperation
} from '../../agent-spec/agent-search';
import type { McpScope, OrchardClient } from '../client';
import { SENSITIVE_META_KEY } from '../catalog';
import { capOutput, errorResult, executeCall, type ToolResult } from './call-api';
import { loadAgentSpec } from './spec';

export const COMPACT_INSTRUCTIONS = `Orchard REST API in three tools. search_api finds operations, describe_operation shows params and schemas, call_api runs one. Ids in paths are UUIDs from earlier calls (start with search_api "list deployments" or "find"). Use fields to trim big responses. Destructive operations need confirm set to the operationId, after the user agrees.`;

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: capOutput(JSON.stringify(value)) }] };
}

export interface CompactDeps {
  loadOperations: () => Promise<AgentOperation[]>;
}

export function registerCompactTools(
  server: McpServer,
  client: Pick<OrchardClient, 'request'>,
  scope: McpScope,
  deps: CompactDeps
) {
  server.registerTool(
    'search_api',
    {
      title: 'Search the Orchard API',
      description:
        'Find Orchard API operations by keywords, e.g. "deployment logs", "restart", "database connection", "rollout status". Returns operationId, method, path, summary and sensitive/destructive flags, best match first.',
      inputSchema: {
        query: z.string().min(1).describe('What you want to do, in a few words'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ query, limit }) => {
      const hits = searchOperations(await deps.loadOperations(), query, limit ?? 8).map(
        ({ score: _score, ...hit }) => hit
      );
      return text({ results: hits });
    }
  );

  server.registerTool(
    'describe_operation',
    {
      title: 'Describe an Orchard API operation',
      description:
        'Full contract for one operation: path and query params, request body schema, response schema, required scope and flags. Accepts an operationId or "METHOD /path".',
      inputSchema: {
        operationId: z.string().min(1).describe('operationId from search_api, or "GET /path"')
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ operationId }) => {
      const operation = findOperation(await deps.loadOperations(), operationId);
      if (!operation) {
        return errorResult(`No operation "${operationId}". Use search_api to find one.`);
      }
      return text(operation);
    }
  );

  server.registerTool(
    'call_api',
    {
      title: 'Call an Orchard API operation',
      description: `Run one Orchard API operation as the connected user and return its JSON.
- pathParams fills :params in the path, e.g. {"id":"<uuid>"}.
- query and body follow describe_operation.
- fields keeps only dotted paths, e.g. ["items.id","items.status"]. Output over 24k chars is truncated.
- Destructive operations refuse unless confirm equals the operationId.
- Long waits: deployments_rollout_get with query {"wait":1}.`,
      inputSchema: {
        operationId: z.string().min(1).describe('operationId from search_api'),
        pathParams: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Values for :params in the path'),
        query: z.record(z.string(), z.unknown()).optional().describe('Query string parameters'),
        body: z.unknown().optional().describe('JSON request body'),
        fields: z
          .array(z.string())
          .max(500)
          .optional()
          .describe('Dotted paths to keep in the response'),
        confirm: z.string().optional().describe('Set to the operationId to run a destructive call')
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => {
      const operation = findOperation(await deps.loadOperations(), input.operationId);
      if (!operation) {
        return errorResult(`No operation "${input.operationId}". Use search_api to find one.`);
      }
      return executeCall(client, operation, input, scope);
    }
  );
}

export function createCompactMcpServer(client: OrchardClient, scope: McpScope) {
  const server = new McpServer(
    { name: 'orchard-compact', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: COMPACT_INSTRUCTIONS }
  );
  registerCompactTools(server, client, scope, {
    loadOperations: async () => (await loadAgentSpec(client.apiBaseUrl)).operations
  });
  return server;
}

export { SENSITIVE_META_KEY };
