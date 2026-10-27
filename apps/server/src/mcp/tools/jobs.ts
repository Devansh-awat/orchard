import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path, query } from '../client';
import { capText, json, paginate, text } from './reply';
import { pageInput } from './inputs';

const stepSchema = z.object({
  name: z.string().max(255).optional().describe('Step display name'),
  type: z
    .enum(['script', 'app', 'image'])
    .describe(
      "script = inline script in a curated runtime; app = command in an existing deployment's image+env; image = arbitrary container image"
    ),
  script: z.string().max(65536).optional().describe('Script source (script type)'),
  scriptRuntime: z
    .enum(['bash', 'python', 'node'])
    .optional()
    .describe('Script runtime (script type)'),
  deploymentId: z
    .guid()
    .optional()
    .describe('Deployment UUID (app type, must belong to the same project)'),
  image: z.string().optional().describe('Container image reference (image type)'),
  command: z
    .string()
    .optional()
    .describe(
      'Shell command; required for app steps, optional for image steps (defaults to the image entrypoint)'
    ),
  envVars: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
        secret: z
          .boolean()
          .optional()
          .describe('Store write-only and inject from a Kubernetes Secret. Reads return it masked.')
      })
    )
    .optional()
    .describe(
      'Environment variables (for app steps these override the deployment env). A value of `${{shared.KEY}}` expands to the environment shared variable KEY when the step pod is built, same as for deployments. Mark tokens and passwords secret: true.'
    ),
  timeoutSeconds: z
    .number()
    .int()
    .min(30)
    .max(21600)
    .optional()
    .describe('Per-step timeout (default 1800)'),
  retries: z.number().int().min(0).max(3).optional().describe('Retries on failure (default 0)'),
  cpuRequestMilli: z
    .number()
    .int()
    .min(50)
    .max(8000)
    .optional()
    .describe('CPU request in millicores'),
  memoryRequestBytes: z.string().optional().describe('Memory request in bytes')
});

export function registerJobTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_jobs',
    {
      description: `List all jobs (scheduled/on-demand multi-step pipelines running as Kubernetes Jobs) in an organization, with schedule, last run status, and next run time.`,
      inputSchema: {
        organizationId: z.guid().describe('The organization UUID'),
        ...pageInput
      }
    },
    async ({ organizationId, limit, cursor }) => {
      const result = await client.get(path`/organizations/${organizationId}/jobs`);
      return json(Array.isArray(result) ? paginate(result, { limit, cursor }) : result);
    }
  );

  server.registerTool(
    'get_job',
    {
      description: `Get a job's full definition including its ordered steps.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID')
      }
    },
    async ({ jobId }) => {
      const result = await client.get(path`/jobs/${jobId}`);
      return json(result);
    }
  );

  server.registerTool(
    'create_job',
    {
      description: `Create a job in a project: an ordered pipeline of steps that runs on a cron schedule and/or on demand. Steps run in the project's namespace and count toward its quota. A failing step stops the pipeline. Cron is 5-field, interpreted in UTC.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID the job belongs to'),
        name: z.string().max(255).describe('Job name, unique within the project'),
        description: z.string().optional().describe('Optional description'),
        scheduleCron: z
          .string()
          .optional()
          .describe('5-field cron schedule (UTC); omit for manual-only'),
        concurrencyPolicy: z
          .enum(['forbid', 'allow'])
          .optional()
          .describe(
            'forbid (default) skips a scheduled fire while a run is active; allow runs them in parallel'
          ),
        enabled: z.boolean().optional().describe('false creates the job with a paused schedule'),
        steps: z.array(stepSchema).min(1).max(10).describe('Ordered pipeline steps')
      }
    },
    async ({ projectId, ...body }) => {
      const result = await client.post(path`/projects/${projectId}/jobs`, body);
      return json(result);
    }
  );

  server.registerTool(
    'update_job',
    {
      description: `Update a job's name, description, schedule, concurrency policy, or enabled state (enabled=false pauses the schedule). To change steps, use replace_job_steps. Only provided fields change.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID'),
        name: z.string().max(255).optional(),
        description: z.string().nullable().optional(),
        scheduleCron: z
          .string()
          .nullable()
          .optional()
          .describe('New 5-field cron (UTC), or null to make the job manual-only'),
        concurrencyPolicy: z.enum(['forbid', 'allow']).optional(),
        enabled: z.boolean().optional().describe('false pauses the schedule, true resumes it')
      }
    },
    async ({ jobId, ...body }) => {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) patch[k] = v;
      }
      const result = await client.patch(path`/jobs/${jobId}`, patch);
      return json(result);
    }
  );

  server.registerTool(
    'replace_job_steps',
    {
      description: `Replace a job's entire ordered step list. Running runs keep their snapshot; future runs use the new steps.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID'),
        steps: z.array(stepSchema).min(1).max(10).describe('The new ordered step list')
      }
    },
    async ({ jobId, steps }) => {
      const result = await client.put(path`/jobs/${jobId}/steps`, { steps });
      return json(result);
    }
  );

  server.registerTool(
    'run_job',
    {
      description: `Trigger a job run now. Fails with a conflict if a run is already active and the job's concurrency policy is forbid (pass allowConcurrent to override). Returns the new run.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID'),
        allowConcurrent: z.boolean().optional().describe('Start even if another run is active')
      }
    },
    async ({ jobId, allowConcurrent }) => {
      const result = await client.post(path`/jobs/${jobId}/runs`, { allowConcurrent });
      return json(result);
    }
  );

  server.registerTool(
    'list_job_runs',
    {
      description: `List a job's run history, newest first, with per-run status and step summaries. Paginate with the returned nextCursor.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID'),
        cursor: z.string().optional().describe('Pagination cursor from a previous call'),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ jobId, cursor, limit }) => {
      const result = await client.get(path`/jobs/${jobId}/runs` + query({ cursor, limit }));
      return json(result);
    }
  );

  server.registerTool(
    'get_job_run',
    {
      description: `Get a run's detail: status, trigger, timing, and each step's status, exit code, and failure reason.`,
      inputSchema: {
        runId: z.guid().describe('The run UUID')
      }
    },
    async ({ runId }) => {
      const result = await client.get(path`/job-runs/${runId}`);
      return json(result);
    }
  );

  server.registerTool(
    'get_job_run_logs',
    {
      description: `Get the logs of one step of a job run. Historical steps return captured logs; a currently running step returns a live tail. Capped at the last 20,000 characters.`,
      inputSchema: {
        runId: z.guid().describe('The run UUID'),
        stepOrder: z.number().int().min(1).describe('The 1-based step number')
      }
    },
    async ({ runId, stepOrder }) => {
      const result = await client.get(path`/job-runs/${runId}/steps/${stepOrder}/logs`);
      if (typeof result === 'string') return text(capText(result).text);
      if (result && typeof result.logs === 'string') {
        const { text: logs, truncated } = capText(result.logs);
        return json({ ...result, logs, ...(truncated ? { truncated: true } : {}) });
      }
      return json(result);
    }
  );

  server.registerTool(
    'cancel_job_run',
    {
      description: `Cancel an in-progress job run: the active step's Kubernetes Job is deleted and remaining steps are skipped.`,
      inputSchema: {
        runId: z.guid().describe('The run UUID')
      }
    },
    async ({ runId }) => {
      const result = await client.post(path`/job-runs/${runId}/cancel`, {});
      return json(result);
    }
  );

  server.registerTool(
    'delete_job',
    {
      description: `Delete a job, its schedule, and its entire run history. Any active run is stopped. This cannot be undone.`,
      inputSchema: {
        jobId: z.guid().describe('The job UUID')
      }
    },
    async ({ jobId }) => {
      const result = await client.delete(path`/jobs/${jobId}`);
      return json(result);
    }
  );
}
