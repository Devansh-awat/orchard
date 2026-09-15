import { z } from 'zod';
import type { RouteAttachment } from '../types';

const stepType = z.enum(['script', 'app', 'image']);
const scriptRuntime = z.enum(['bash', 'python', 'node']);
const concurrencyPolicy = z.enum(['forbid', 'allow']);
const runStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'skipped',
  'timed_out'
]);
const runTrigger = z.enum(['manual', 'api', 'cron']);

const envVar = z.object({ key: z.string(), value: z.string() });

const stepInput = z
  .object({
    name: z.string().max(255).optional().describe('Step display name'),
    type: stepType.describe(
      "script = inline script in a curated runtime; app = command in an existing deployment's image+env; image = arbitrary container image"
    ),
    script: z.string().max(65536).optional().describe('Script source (script type)'),
    scriptRuntime: scriptRuntime.optional().describe('Script runtime (script type)'),
    deploymentId: z
      .string()
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
      .array(envVar)
      .optional()
      .describe('Environment variables (for app steps these override the deployment env)'),
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
    // BigInt on the server; accepts a numeric string or number, 64Mi..16Gi
    memoryRequestBytes: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Memory request in bytes')
  })
  .passthrough();

const jobCreateRequest = z
  .object({
    name: z.string().max(255).describe('Job name, unique within the project'),
    description: z.string().optional(),
    scheduleCron: z
      .string()
      .optional()
      .describe('5-field cron schedule (UTC unless timeZone is set); omit for manual-only'),
    timeZone: z.string().optional().describe('IANA time zone for the cron schedule (default UTC)'),
    concurrencyPolicy: concurrencyPolicy
      .optional()
      .describe(
        'forbid (default) skips a scheduled fire while a run is active; allow runs them in parallel'
      ),
    enabled: z.boolean().optional().describe('false creates the job with a paused schedule'),
    runTimeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(21600)
      .optional()
      .describe('Whole-run timeout in seconds (default 21600)'),
    steps: z.array(stepInput).min(1).max(10).describe('Ordered pipeline steps')
  })
  .passthrough();

const jobPatchRequest = z
  .object({
    name: z.string().max(255).optional(),
    description: z.string().nullable().optional(),
    scheduleCron: z
      .string()
      .nullable()
      .optional()
      .describe(
        'New 5-field cron (UTC unless timeZone is set), or null to make the job manual-only'
      ),
    timeZone: z.string().nullable().optional(),
    concurrencyPolicy: concurrencyPolicy.optional(),
    enabled: z.boolean().optional().describe('false pauses the schedule, true resumes it'),
    runTimeoutSeconds: z.number().int().min(60).max(21600).nullable().optional()
  })
  .passthrough();

const replaceStepsRequest = z
  .object({
    steps: z.array(stepInput).min(1).max(10).describe('The new ordered step list')
  })
  .passthrough();

const lastRunBrief = z
  .object({
    id: z.string(),
    number: z.number().int(),
    status: runStatus,
    trigger: runTrigger,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string()
  })
  .passthrough();

const recentRunBrief = z
  .object({
    id: z.string(),
    number: z.number().int(),
    status: runStatus,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable()
  })
  .passthrough();

const jobSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    projectId: z.string(),
    projectName: z.string().optional(),
    projectSlug: z.string().optional(),
    organizationId: z
      .string()
      .optional()
      .describe('Present on detail responses, absent on list responses'),
    scheduleCron: z.string().nullable(),
    timeZone: z.string().nullable(),
    enabled: z.boolean(),
    concurrencyPolicy,
    runTimeoutSeconds: z.number().int(),
    stepCount: z.number().int().optional(),
    stepSummaries: z.array(z.object({ name: z.string(), type: stepType }).passthrough()).optional(),
    lastRun: lastRunBrief.nullable(),
    recentRuns: z.array(recentRunBrief),
    nextRunAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .passthrough();

const stepDetail = z
  .object({
    id: z.string(),
    stepOrder: z.number().int(),
    name: z.string(),
    type: stepType,
    deploymentId: z.string().nullable(),
    image: z.string().nullable(),
    command: z.string().nullable(),
    script: z.string().nullable(),
    scriptRuntime: scriptRuntime.nullable(),
    envVars: z.array(envVar),
    cpuRequestMilli: z.number().int().nullable(),
    // BigInt column; the server serializes it to a string
    memoryRequestBytes: z.union([z.string(), z.number()]).nullable(),
    timeoutSeconds: z.number().int(),
    retries: z.number().int()
  })
  .passthrough();

const jobDetail = jobSummary.extend({ steps: z.array(stepDetail) });

const runStep = z
  .object({
    id: z.string().optional(),
    stepOrder: z.number().int(),
    name: z.string(),
    type: stepType.optional(),
    resolvedImage: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    status: runStatus,
    exitCode: z.number().int().nullable().optional(),
    reason: z.string().nullable().optional(),
    logsTruncated: z.boolean().optional(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional()
  })
  .passthrough();

const runDetail = z
  .object({
    id: z.string(),
    jobId: z.string(),
    jobName: z.string().optional(),
    number: z.number().int(),
    trigger: runTrigger,
    status: runStatus,
    currentStepOrder: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    scheduledFor: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
    triggeredBy: z
      .object({ id: z.string(), username: z.string(), name: z.string() })
      .passthrough()
      .nullable(),
    steps: z.array(runStep).optional()
  })
  .passthrough();

const runsPage = z
  .object({
    runs: z.array(runDetail),
    nextCursor: z.string().nullable()
  })
  .passthrough();

const stepLogs = z
  .object({
    logs: z.string(),
    truncated: z.boolean(),
    live: z.boolean().describe('true when the step is running and this is a live tail')
  })
  .passthrough();

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /organizations/:orgId/jobs': {
    summary: 'List jobs across an organization',
    response: z.array(jobSummary)
  },
  'GET /projects/:projectId/jobs': {
    summary: 'List jobs in a project',
    response: z.array(jobSummary)
  },
  'POST /projects/:projectId/jobs': {
    summary: 'Create a job (ordered pipeline of steps, cron and/or on demand)',
    request: jobCreateRequest,
    response: jobDetail
  },
  'GET /jobs/:id': {
    summary: "Get a job's full definition including its ordered steps",
    response: jobDetail
  },
  'PATCH /jobs/:id': {
    summary: "Update a job's name, description, schedule, concurrency policy, or enabled state",
    request: jobPatchRequest,
    response: jobDetail
  },
  'PUT /jobs/:id/steps': {
    summary: "Replace a job's entire ordered step list",
    request: replaceStepsRequest,
    response: jobDetail
  },
  'DELETE /jobs/:id': {
    summary: 'Delete a job, its schedule, and its run history',
    response: z.object({ success: z.boolean() }).passthrough()
  },
  'POST /jobs/:id/runs': {
    summary: 'Trigger a job run now (409 if a run is active and the policy is forbid)',
    request: z
      .object({
        allowConcurrent: z.boolean().optional().describe('Start even if another run is active')
      })
      .passthrough(),
    response: runDetail
  },
  'GET /jobs/:id/runs': {
    summary: "List a job's run history, newest first (cursor-paginated)",
    request: z.object({
      cursor: z.string().optional().describe('Pagination cursor from a previous call'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)')
    }),
    response: runsPage
  },
  'GET /job-runs/:runId': {
    summary: "Get a run's detail: status, trigger, timing, and per-step results",
    response: runDetail
  },
  'POST /job-runs/:runId/cancel': {
    summary: 'Cancel an in-progress run; remaining steps are skipped',
    response: runDetail
  },
  'GET /job-runs/:runId/steps/:order/logs': {
    summary: 'Get the logs of one step of a run (live tail while running)',
    response: stepLogs
  }
};
