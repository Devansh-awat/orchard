import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path, query } from '../client';
import { json, structured } from './reply';
import { pageInput } from './inputs';
import { rolloutOutput } from './outputs';

const MAX_HISTORY = 200;

async function serverPage(
  client: OrchardClient,
  route: string,
  limit = 20,
  cursor?: string
): Promise<{ items: unknown[]; nextCursor?: string }> {
  const offset = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0);
  const want = Math.min(MAX_HISTORY, offset + limit + 1);
  const result = await client.get(route + query({ limit: want }));
  const all: unknown[] = Array.isArray(result) ? result : (result?.items ?? result?.runs ?? []);
  const items = all.slice(offset, offset + limit);
  const next = offset + items.length;
  return {
    items,
    ...(all.length > next && next < MAX_HISTORY ? { nextCursor: String(next) } : {})
  };
}

export function registerRolloutTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_deployment_rollout',
    {
      description: `Is the deployment live, and if not, why? One call that answers the question every deploy ends with.

Returns \`phase\` (queued, building, deploying, live, build_failed, crashing, unhealthy, stopped), \`terminal\`, \`releaseId\`, \`url\`, a \`build\` block (status, step, error, logTail) and a \`pods\` block (desired, ready, failing pods with reason, exit code and log tail), plus a plain-language \`hint\`.

Pass \`wait: true\` to long-poll until the rollout reaches a terminal phase or \`timeout\` seconds pass (max 120). Pass the \`releaseId\` returned by restart/rebuild/rollback as \`release\` so the wait cannot be satisfied by the old pods. Prefer this over polling get_deployment.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        wait: z.boolean().optional().describe('Block until a terminal phase or the timeout'),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe('Seconds to wait when wait is true (default 60, max 120)'),
        release: z
          .string()
          .optional()
          .describe('Release id to pin the wait to, from the mutating call that started it')
      },
      outputSchema: rolloutOutput
    },
    async ({ deploymentId, wait, timeout, release }) => {
      const rollout = await client.get(
        path`/deployments/${deploymentId}/rollout` +
          query({ wait: wait ? '1' : undefined, timeout, release })
      );
      return structured(rollout ?? {});
    }
  );

  server.registerTool(
    'list_build_runs',
    {
      description: `Build history for a deployment, newest first: one entry per build with status, trigger, commit, timings and the failure summary. Use it to answer "when did the build start failing" or to pick a run for build logs.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        ...pageInput
      }
    },
    async ({ deploymentId, limit, cursor }) => {
      return json(
        await serverPage(client, path`/deployments/${deploymentId}/build-runs`, limit, cursor)
      );
    }
  );

  server.registerTool(
    'list_releases',
    {
      description: `Release history for a deployment, newest first: what image each release ran, when it went out and who or what triggered it. A release id from here can be passed to get_deployment_rollout as \`release\`.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        ...pageInput
      }
    },
    async ({ deploymentId, limit, cursor }) => {
      return json(
        await serverPage(client, path`/deployments/${deploymentId}/releases`, limit, cursor)
      );
    }
  );

  server.registerTool(
    'rollback_to_previous',
    {
      description: `Roll a deployment back to the release before the current one, without having to look up an image history id. Returns the new releaseId; follow with get_deployment_rollout (wait: true, release: <releaseId>) to confirm it came up. Use rollback_deployment to pick a specific older version.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const result = await client.post(path`/deployments/${deploymentId}/rollback`);
      return json(result);
    }
  );
}
