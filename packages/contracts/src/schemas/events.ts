import { z } from 'zod';
import type { RouteAttachment } from '../types';

const orgEventType = z.enum([
  'deployment.changed',
  'database.changed',
  'build.changed',
  'project.changed',
  'pod.changed',
  'membership.changed',
  'deployment.metrics',
  'job.changed',
  'jobrun.changed',
  'environment.changed',
  'sharedvars.changed',
]);

export const jobRunChangedPayload = z
  .object({
    jobId: z.string(),
    runId: z.string(),
    number: z.number().int(),
    status: z.string(),
    currentStepOrder: z.number().int().nullable(),
  })
  .passthrough()
  .describe('Payload for jobrun.changed events');

export const deploymentMetricsPayload = z
  .object({
    totalCpuUsage: z.number().describe('Total CPU usage across pods, millicores'),
    totalMemoryUsage: z.number().describe('Total memory usage across pods, bytes'),
    pods: z.record(
      z.object({ cpuUsage: z.number(), memoryUsage: z.number() }).passthrough(),
    ),
  })
  .passthrough()
  .describe('Payload for deployment.metrics events, keyed by pod name');

export const orgEvent = z
  .object({
    organizationId: z.string(),
    type: orgEventType,
    id: z
      .string()
      .optional()
      .describe(
        'The changed entity id (deployment, database, job, run, environment, ...); the affected user id for membership.changed',
      ),
    projectId: z.string().optional(),
    ts: z.number().describe('Emit time, Unix epoch milliseconds'),
    payload: z
      .union([jobRunChangedPayload, deploymentMetricsPayload, z.unknown()])
      .optional()
      .describe(
        'Event-specific payload: structured for jobrun.changed and deployment.metrics, informer-derived data for pod.changed and database.changed, absent otherwise',
      ),
  })
  .passthrough();

export const heartbeatEvent = z
  .object({
    type: z.literal('heartbeat'),
    ts: z.number(),
  })
  .passthrough()
  .describe('Keepalive sent every 25s so proxies do not kill the stream');

export const orgEventStreamMessage = z
  .union([orgEvent, heartbeatEvent])
  .describe('The JSON-decoded data field of one SSE message on the org event stream');

export const terminalClientResizeFrame = z
  .object({
    type: z.literal('resize'),
    cols: z.number().int(),
    rows: z.number().int(),
  })
  .passthrough()
  .describe('Terminal resize notification (JSON text frame, handled client-side)');

export const terminalClientInputFrame = z
  .string()
  .describe('Raw terminal input forwarded to the shell stdin (any non-resize text frame)');

export const terminalClientFrame = z
  .union([terminalClientResizeFrame, terminalClientInputFrame])
  .describe(
    'Client-to-server frame on ws(s)://host/apiv1/pods/:podName/exec?namespace=...&container=... (session cookie or Bearer API token with the exec scope; project edit access required)',
  );

export const terminalServerFrame = z
  .string()
  .describe(
    'Server-to-client frame: raw stdout/stderr bytes (binary), or a text notice before close. Close codes: 1000 shell exited, 4401 access revoked mid-session, 1011 exec error',
  );

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /events/orgs/:orgId': {
    summary:
      'Server-sent events stream of org changes, scoped to projects the caller can see; each SSE message data field is one JSON event, resumable via Last-Event-ID',
    request: z.object({
      lastEventId: z
        .string()
        .optional()
        .describe(
          'Resume after this event id (Redis stream id); the Last-Event-ID header takes precedence',
        ),
    }),
    response: orgEventStreamMessage,
  },
  'POST /pods/:podName/exec': {
    summary: 'Run a one-shot command in a pod (synchronous, non-streaming)',
    scope: 'exec',
    request: z
      .object({
        namespace: z
          .string()
          .optional()
          .describe('Pod namespace; required here or as a ?namespace= query param'),
        command: z
          .union([z.string(), z.array(z.string())])
          .describe("Command to run; a string is wrapped as ['/bin/sh', '-c', command]"),
        container: z
          .string()
          .optional()
          .describe('Container name (defaults to the first container in the pod spec)'),
        timeoutMs: z
          .number()
          .int()
          .optional()
          .describe('Timeout in milliseconds, clamped to 1000..300000 (default 60000)'),
      })
      .passthrough(),
    response: z
      .object({
        stdout: z.string(),
        stderr: z.string(),
        success: z.boolean(),
        container: z.string().describe('The container the command ran in'),
      })
      .passthrough(),
  },
};
