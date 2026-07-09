import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

const stepSchema = z.object({
  name: z.string().max(255).optional().describe('Step display name'),
  type: z.enum(['script', 'app', 'image']).describe('script = inline script in a curated runtime; app = command in an existing deployment\'s image+env; image = arbitrary container image'),
  script: z.string().max(65536).optional().describe('Script source (script type)'),
  scriptRuntime: z.enum(['bash', 'python', 'node']).optional().describe('Script runtime (script type)'),
  deploymentId: z.string().optional().describe('Deployment UUID (app type, must belong to the same project)'),
  image: z.string().optional().describe('Container image reference (image type)'),
  command: z.string().optional().describe('Shell command; required for app steps, optional for image steps (defaults to the image entrypoint)'),
  envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe('Environment variables (for app steps these override the deployment env)'),
  timeoutSeconds: z.number().int().min(30).max(21600).optional().describe('Per-step timeout (default 1800)'),
  retries: z.number().int().min(0).max(3).optional().describe('Retries on failure (default 0)'),
  cpuRequestMilli: z.number().int().min(50).max(8000).optional().describe('CPU request in millicores'),
  memoryRequestBytes: z.string().optional().describe('Memory request in bytes'),
});

export function registerJobTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_jobs',
    {
      description: `List all jobs (scheduled/on-demand multi-step pipelines running as Kubernetes Jobs) in an organization, with schedule, last run status, and next run time.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        organizationId: z.string().describe('The organization UUID'),
      },
    },
    async ({ organizationId }) => {
      const result = await client.get(`/organizations/${organizationId}/jobs`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_job',
    {
      description: `Get a job's full definition including its ordered steps.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
      },
    },
    async ({ jobId }) => {
      const result = await client.get(`/jobs/${jobId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'create_job',
    {
      description: `Create a job in a project: an ordered pipeline of steps that runs on a cron schedule and/or on demand. Steps run in the project's namespace and count toward its quota. A failing step stops the pipeline. Cron is 5-field, interpreted in UTC.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID the job belongs to'),
        name: z.string().max(255).describe('Job name, unique within the project'),
        description: z.string().optional().describe('Optional description'),
        scheduleCron: z.string().optional().describe('5-field cron schedule (UTC); omit for manual-only'),
        concurrencyPolicy: z.enum(['forbid', 'allow']).optional().describe('forbid (default) skips a scheduled fire while a run is active; allow runs them in parallel'),
        enabled: z.boolean().optional().describe('false creates the job with a paused schedule'),
        steps: z.array(stepSchema).min(1).max(10).describe('Ordered pipeline steps'),
      },
    },
    async ({ projectId, ...body }) => {
      const result = await client.post(`/projects/${projectId}/jobs`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_job',
    {
      description: `Update a job's name, description, schedule, concurrency policy, or enabled state (enabled=false pauses the schedule). To change steps, use replace_job_steps. Only provided fields change.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
        name: z.string().max(255).optional(),
        description: z.string().nullable().optional(),
        scheduleCron: z.string().nullable().optional().describe('New 5-field cron (UTC), or null to make the job manual-only'),
        concurrencyPolicy: z.enum(['forbid', 'allow']).optional(),
        enabled: z.boolean().optional().describe('false pauses the schedule, true resumes it'),
      },
    },
    async ({ jobId, ...body }) => {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) patch[k] = v;
      }
      const result = await client.patch(`/jobs/${jobId}`, patch);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'replace_job_steps',
    {
      description: `Replace a job's entire ordered step list. Running runs keep their snapshot; future runs use the new steps.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
        steps: z.array(stepSchema).min(1).max(10).describe('The new ordered step list'),
      },
    },
    async ({ jobId, steps }) => {
      const result = await client.put(`/jobs/${jobId}/steps`, { steps });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'run_job',
    {
      description: `Trigger a job run now. Fails with a conflict if a run is already active and the job's concurrency policy is forbid (pass allowConcurrent to override). Returns the new run.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
        allowConcurrent: z.boolean().optional().describe('Start even if another run is active'),
      },
    },
    async ({ jobId, allowConcurrent }) => {
      const result = await client.post(`/jobs/${jobId}/runs`, { allowConcurrent });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_job_runs',
    {
      description: `List a job's run history, newest first, with per-run status and step summaries. Paginate with the returned nextCursor.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
        cursor: z.string().optional().describe('Pagination cursor from a previous call'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ jobId, cursor, limit }) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      const qs = params.toString();
      const result = await client.get(`/jobs/${jobId}/runs${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_job_run',
    {
      description: `Get a run's detail: status, trigger, timing, and each step's status, exit code, and failure reason.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        runId: z.string().describe('The run UUID'),
      },
    },
    async ({ runId }) => {
      const result = await client.get(`/job-runs/${runId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_job_run_logs',
    {
      description: `Get the logs of one step of a job run. Historical steps return captured logs; a currently running step returns a live tail.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        runId: z.string().describe('The run UUID'),
        stepOrder: z.number().int().min(1).describe('The 1-based step number'),
      },
    },
    async ({ runId, stepOrder }) => {
      const result = await client.get(`/job-runs/${runId}/steps/${stepOrder}/logs`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'cancel_job_run',
    {
      description: `Cancel an in-progress job run: the active step's Kubernetes Job is deleted and remaining steps are skipped.`,
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        runId: z.string().describe('The run UUID'),
      },
    },
    async ({ runId }) => {
      const result = await client.post(`/job-runs/${runId}/cancel`, {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_job',
    {
      description: `Delete a job, its schedule, and its entire run history. Any active run is stopped. This cannot be undone.`,
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        jobId: z.string().describe('The job UUID'),
      },
    },
    async ({ jobId }) => {
      const result = await client.delete(`/jobs/${jobId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
