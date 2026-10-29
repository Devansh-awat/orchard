import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path, query } from '../client';
import { capJson, capLines, capList, json } from './reply';

const time = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v) => (v == null ? undefined : typeof v === 'number' ? v : Date.parse(v)));

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

const PANELS: Record<string, string> = {
  errors: 'panel-error-rate',
  latency: 'panel-response-time',
  requests: 'panel-requests',
  cpu: 'panel-cpu',
  throttling: 'panel-cpu-throttling',
  memory: 'panel-memory',
  restarts: 'panel-restarts-and-out-of-memory-kills'
};

export function registerObservabilityTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'diagnose_deployment',
    {
      description: `**Call this first** for any "what is wrong with this app" or "is it healthy" question. One compact answer that composes everything Orchard knows about a deployment:

- \`health\`: what is wrong right now (crash loops, out of memory, stuck rollouts, failed builds), each with a title and a hint
- \`rollout\` and the latest deploy \`verdict\` ("v7: responses 38% slower (p95 180 → 248 ms)")
- \`findings\`: plain sentences that tie a symptom to its cause ("Errors went from 0.2% to 4.1% at 14:02, two minutes after v7 went live."), each with a \`link\` to that moment
- \`changes\` in the last 24h (deploys, config, evictions, node events)
- \`resources\`: usage against limits, CPU throttling, a memory leak forecast and a right-sizing suggestion
- \`http\`: request rate, error %, p95 and the worst routes
- \`security\`: worst CVE and attack attempts; \`topErrors\`: the most frequent error groups
- \`links\`: where to send a human

Parts that could not be measured are listed in \`unavailable\` instead of failing the call. Follow up with search_logs, get_request_stats or get_changes for detail.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        timezone: z
          .string()
          .optional()
          .describe('IANA zone for times in sentences, e.g. Europe/London. Default UTC')
      }
    },
    async ({ deploymentId, timezone }) =>
      json(
        capJson(
          await client.get(path`/deployments/${deploymentId}/diagnosis` + query({ tz: timezone }))
        )
      )
  );

  server.registerTool(
    'search_logs',
    {
      description: `Search an app's stored logs (every replica, past pods included, up to the retention window) with typed filters. Returns plain text lines, newest first: \`time pod LEVEL message\`. \`source\` says whether the answer came from the log store or a live read of the running pods.

Pass the returned \`cursor\` to get the next older page. Output is capped near 40 KB; \`truncated: true\` means there is more.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        q: z
          .string()
          .max(1000)
          .optional()
          .describe('Words or "quoted phrases" that must all appear'),
        levels: z.array(z.enum(LEVELS)).optional().describe('Only these levels'),
        pods: z.array(z.string()).max(50).optional().describe('Only these pod names'),
        start: time.describe('Window start, unix ms or ISO time. Default: end - 1h'),
        end: time.describe('Window end, unix ms or ISO time. Default: now'),
        limit: z.number().int().min(1).max(500).optional().describe('Lines per page (max 500)'),
        cursor: z.string().optional().describe('From a previous call, for the next older page')
      }
    },
    async ({ deploymentId, q, levels, pods, start, end, limit, cursor }) => {
      const result = await client.get(
        path`/observe/deployments/${deploymentId}/logs/search` +
          query({
            q,
            levels: levels?.join(','),
            pods: pods?.join(','),
            start,
            end,
            limit: limit ?? 200,
            cursor
          })
      );
      const capped = capLines(result?.entries ?? [], result?.cursor ?? null);
      return json({ source: result?.source ?? null, ...capped });
    }
  );

  server.registerTool(
    'get_log_context',
    {
      description: `The app's log lines around one moment: what happened just before and after a log line or a request. Oldest first. Leave \`pod\` out to read every replica.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        at: z.union([z.number(), z.string()]).describe('The moment, unix ms or ISO time'),
        pod: z.string().optional().describe('Pod name, to read only that replica'),
        beforeSeconds: z.number().int().min(1).max(3600).optional().describe('Default 60'),
        afterSeconds: z.number().int().min(1).max(3600).optional().describe('Default 60')
      }
    },
    async ({ deploymentId, at, pod, beforeSeconds, afterSeconds }) => {
      const ms = typeof at === 'number' ? at : Date.parse(at);
      const result = await client.get(
        path`/observe/deployments/${deploymentId}/logs/context` +
          query({
            at: ms,
            pod,
            before: (beforeSeconds ?? 60) * 1000,
            after: (afterSeconds ?? 60) * 1000
          })
      );
      const capped = capLines(result?.entries ?? [], null);
      return json({ source: result?.source ?? null, ...capped });
    }
  );

  server.registerTool(
    'get_request_stats',
    {
      description: `Request data from the ingress access logs: \`routes\` (per host and route with ids collapsed: rate, error %, p50/p95/p99), \`slowest\` (the slowest individual requests), \`recent\` (the newest requests) or \`clients\` (top client IPs and user agents). Needs the log store; answers 503 without one.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        view: z.enum(['routes', 'slowest', 'recent', 'clients']).describe('Which slice'),
        start: time.describe('Window start. Default: end - 1h'),
        end: time.describe('Window end. Default: now'),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ deploymentId, view, start, end, limit }) =>
      json(
        capJson(
          await client.get(
            path`/observe/deployments/${deploymentId}/requests` + query({ view, start, end, limit })
          )
        )
      )
  );

  server.registerTool(
    'get_changes',
    {
      description: `Everything that changed around a deployment in a window, oldest first: deploys and rollbacks with their version, config, env and resource edits with who made them, failed builds, evictions, failed scheduling, failing probes and node cordons or pressure. The same markers the dashboard draws on every chart.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        start: time.describe('Window start. Default: end - 24h'),
        end: time.describe('Window end. Default: now')
      }
    },
    async ({ deploymentId, start, end }) => {
      const result = await client.get(
        path`/observe/deployments/${deploymentId}/changes` + query({ start, end })
      );
      const changes = (result?.changes ?? []).map((c: any) => ({
        at: new Date(c.t).toISOString(),
        kind: c.kind,
        label: c.label,
        detail: c.detail,
        actor: c.actor?.name ?? null
      }));
      return json(capList(changes));
    }
  );

  server.registerTool(
    'get_deploy_verdict',
    {
      description: `How one release changed the app: the 15 minutes after it settled against the 15 minutes before it went live (p95, errors, restarts, memory, new error groups), with a one-line summary. Only calls a change a regression when it beats both a relative and an absolute floor. \`pending\` until 15 minutes after the rollout settles.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        releaseId: z.guid().describe('The release id, from list_releases')
      }
    },
    async ({ deploymentId, releaseId }) =>
      json(await client.get(path`/deployments/${deploymentId}/releases/${releaseId}/verdict`))
  );

  server.registerTool(
    'get_resource_recommendation',
    {
      description: `A CPU and memory suggestion from up to 14 days of real usage: memory from the daily peaks plus 15%, the CPU limit from p95 and p99, raised when the app is throttled, never lowered right after a crash. Values are Orchard's own numbers (the CPU limit and the memory limit). To apply one, call update_deployment_resources with **both** cpuRequestMilli and memoryRequestBytes; leaving one out resets it to the organization default.`,
      inputSchema: { deploymentId: z.guid().describe('The deployment UUID') }
    },
    async ({ deploymentId }) =>
      json(await client.get(path`/deployments/${deploymentId}/rightsizing`))
  );

  server.registerTool(
    'get_attack_signals',
    {
      description: `Attack attempts against an app over a window, from its access logs: scanners, injection payloads, password guessing and floods, counted over time, with the top sources and sample requests. IPs are masked to /24 for viewers who cannot edit the project.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        start: time.describe('Window start. Default: end - 24h'),
        end: time.describe('Window end. Default: now')
      }
    },
    async ({ deploymentId, start, end }) =>
      json(
        capJson(
          await client.get(
            path`/deployments/${deploymentId}/security/attacks` + query({ start, end })
          )
        )
      )
  );

  server.registerTool(
    'get_pod_health',
    {
      description:
        'Restarts by reason, waiting containers by reason and pods not ready, over time, from kube-state-metrics.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        start: time.describe('Window start. Default: end - 1h'),
        end: time.describe('Window end. Default: now'),
        step: z.number().int().min(15_000).optional().describe('Sample step in ms')
      }
    },
    async ({ deploymentId, start, end, step }) => {
      const to = end ?? Date.now();
      return json(
        capJson(
          await client.get(
            path`/observe/deployments/${deploymentId}/pod-health` +
              query({ start: start ?? to - 3_600_000, end: to, step })
          )
        )
      );
    }
  );

  server.registerTool(
    'get_volumes',
    {
      description: 'How full each of the app’s persistent volumes is right now.',
      inputSchema: { deploymentId: z.guid().describe('The deployment UUID') }
    },
    async ({ deploymentId }) =>
      json(await client.get(path`/observe/deployments/${deploymentId}/volumes`))
  );

  server.registerTool(
    'get_build_history',
    {
      description:
        'Recent builds with queue wait, duration and where the time went (clone, build, push, apply).',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ deploymentId, limit }) =>
      json(
        capJson(
          await client.get(
            path`/observe/deployments/${deploymentId}/builds` + query({ limit: limit ?? 30 })
          )
        )
      )
  );

  server.registerTool(
    'get_timeline',
    {
      description:
        'The app’s activity feed, newest first: audit events, builds, releases, pod transitions and new errors. Pass `nextCursor` back as `cursor` for older entries.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        kinds: z.array(z.enum(['audit', 'build', 'release', 'pod', 'error'])).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional()
      }
    },
    async ({ deploymentId, kinds, limit, cursor }) =>
      json(
        capJson(
          await client.get(
            path`/observe/deployments/${deploymentId}/timeline` +
              query({ kinds: kinds?.join(','), limit, cursor })
          )
        )
      )
  );

  server.registerTool(
    'get_anomalies',
    {
      description:
        'What looks wrong with the app right now, ranked: out-of-memory kills, crash loops, failed rollouts, failed builds, firing alerts and error spikes.',
      inputSchema: { deploymentId: z.guid().describe('The deployment UUID') }
    },
    async ({ deploymentId }) => json(await client.get(path`/deployments/${deploymentId}/anomalies`))
  );

  server.registerTool(
    'get_alert_states',
    {
      description:
        'The metric alert rules that apply to an app and whether each is ok, pending, firing or recovering, with its current value.',
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ organizationId, deploymentId }) =>
      json(
        await client.get(
          path`/organizations/${organizationId}/metric-alerts/states` + query({ deploymentId })
        )
      )
  );

  server.registerTool(
    'get_observability_link',
    {
      description: `A link a human can open to see the exact moment you are talking about: the Observe dashboard with a 30 minute window around \`at\`, the crosshair on it and the panel scrolled into view and highlighted. Hand this to the user alongside any finding.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        at: z.union([z.number(), z.string()]).describe('The moment, unix ms or ISO time'),
        panel: z.enum(Object.keys(PANELS) as [string, ...string[]]).optional(),
        view: z.enum(['metrics', 'logs', 'requests', 'errors', 'events']).optional()
      }
    },
    async ({ deploymentId, at, panel, view }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      const slug = deployment?.project?.organization?.slug;
      const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      if (!slug || !base)
        return json({ link: null, reason: 'The dashboard address is unknown here' });
      const ms = typeof at === 'number' ? at : Date.parse(at);
      const url = new URL(`${base}/${slug}/deployments/${deploymentId}`);
      url.searchParams.set('tab', 'observe');
      if (view && view !== 'metrics') url.searchParams.set('view', view);
      url.searchParams.set('from', String(ms - 15 * 60_000));
      url.searchParams.set('to', String(Math.min(Date.now(), ms + 15 * 60_000)));
      url.searchParams.set('at', String(ms));
      if (panel) url.searchParams.set('panel', PANELS[panel]);
      return json({ link: url.toString() });
    }
  );
}
