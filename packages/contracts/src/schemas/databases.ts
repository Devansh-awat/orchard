import { z } from 'zod';
import type { RouteAttachment } from '../types';

const passthroughObject = z.object({}).passthrough();

// Advice about a setting that was applied as given. Never a rejection: a manual
// value is honoured however dangerous it looks, and this is how we say so.
const tuningAdvisory = z.object({
  key: z.string(),
  message: z.string()
});

const creatorSchema = z
  .object({
    id: z.string(),
    email: z.string().nullish(),
    username: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish()
  })
  .passthrough();

const liveStatusSchema = z
  .object({
    exists: z.boolean().optional(),
    ready: z.boolean().optional(),
    phase: z.string().optional(),
    readyReplicas: z.number().optional(),
    replicas: z.number().optional(),
    currentPrimary: z.string().optional(),
    size: z.string().optional(),
    connections: z.number().optional(),
    conditions: z.array(passthroughObject).optional(),
    restartCount: z.number().optional(),
    message: z.string().optional(),
    lastTerminationReason: z.string().optional(),
    lastTerminationExitCode: z.number().optional(),
    lastTerminationAt: z.string().optional()
  })
  .passthrough();

const databaseSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    environmentId: z.string().nullish(),
    templateInstanceId: z.string().nullish(),
    name: z.string(),
    dbName: z.string(),
    dbUser: z.string(),
    dbPassword: z.string().nullable(),
    status: z.string(),
    host: z.string(),
    port: z.number(),
    mode: z.string(),
    namespace: z.string().nullish(),
    containerName: z.string().nullish(),
    storageSize: z.string().nullish(),
    clusterName: z.string().nullish(),
    pgParameters: z.record(z.string()).nullish(),
    sharedPreloadLibs: z.array(z.string()).nullish(),
    installedExtensions: z.unknown().nullish(),
    backupScheduleCron: z.string().nullish(),
    importBoosted: z.boolean(),
    publicEnabled: z.boolean(),
    publicIp: z.string().nullish(),
    publicPort: z.number().nullish(),
    cpuRequestMilli: z.number().nullish(),
    // BigInt serializes as a string on the wire
    memoryRequestBytes: z.union([z.string(), z.number()]).nullish(),
    r2ProxyAccessKey: z.string().nullish(),
    r2ProxySecret: z.string().nullish(),
    createdBy: z.string().nullish(),
    createdAt: z.string(),
    updatedAt: z.string(),
    creator: creatorSchema.nullish(),
    liveStatus: liveStatusSchema.optional()
  })
  .passthrough();

const databaseDetailSchema = databaseSchema.extend({
  connectionString: z.string().nullable(),
  internalHost: z.string(),
  publicHostname: z.string().nullable(),
  publicConnectionString: z.string().nullable(),
  liveStatus: liveStatusSchema,
  backupsEnabled: z.boolean(),
  pods: z.array(passthroughObject)
});

const databaseSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    dbName: z.string(),
    status: z.string(),
    mode: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    project: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        organizationId: z.string()
      })
      .passthrough()
  })
  .passthrough();

const backupSchema = z
  .object({
    id: z.string(),
    databaseId: z.string(),
    label: z.string(),
    backupName: z.string(),
    type: z.string(),
    status: z.string(),
    // BigInt serializes as a string on the wire
    sizeBytes: z.union([z.string(), z.number()]).nullish(),
    errorMessage: z.string().nullish(),
    createdBy: z.string().nullish(),
    createdAt: z.string(),
    completedAt: z.string().nullish()
  })
  .passthrough();

const provisioningStepSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    status: z.enum(['pending', 'running', 'done', 'error']),
    detail: z.string().optional()
  })
  .passthrough();

const provisioningSchema = z
  .object({
    databaseId: z.string(),
    status: z.string(),
    mode: z.string(),
    done: z.boolean(),
    failed: z.boolean(),
    phase: z.string().nullish(),
    hasImport: z.boolean(),
    importStatus: z.enum(['pending', 'running', 'completed', 'failed']).nullish(),
    importLogs: z.string().nullish(),
    steps: z.array(provisioningStepSchema),
    conditions: z.array(passthroughObject).optional(),
    events: z.array(passthroughObject),
    pod: passthroughObject.nullish(),
    importPod: passthroughObject.nullish()
  })
  .passthrough();

const seriesPointSchema = z.object({ x: z.number(), y: z.number() });

const metricsResponseSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    step: z.number(),
    data: z
      .object({
        cpu: z.array(seriesPointSchema),
        mem: z.array(seriesPointSchema),
        rx: z.array(seriesPointSchema),
        tx: z.array(seriesPointSchema)
      })
      .passthrough()
  })
  .passthrough();

const extensionSchema = z
  .object({
    name: z.string(),
    installed: z.boolean(),
    version: z.string().optional(),
    defaultVersion: z.string().optional(),
    comment: z.string().optional()
  })
  .passthrough();

const createDatabaseRequest = z.object({
  name: z.string(),
  storageSize: z
    .string()
    .regex(/^\d+(Mi|Gi|Ti)$/)
    .optional()
    .describe('Storage size as a Kubernetes quantity, e.g. "1Gi". Defaults to "1Gi".'),
  restoreFromUrl: z
    .string()
    .optional()
    .describe('Optional postgres:// URL to migrate data from on first boot.'),
  cpuRequestMilli: z.number().int().positive().nullish(),
  memoryRequestBytes: z.number().int().positive().nullish(),
  templateInstanceId: z.string().optional()
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /databases': {
    summary: 'List databases across all projects the caller can access',
    scope: 'read',
    request: z.object({ orgId: z.string().optional() }),
    response: z.array(databaseSummarySchema)
  },
  'GET /databases/:id': {
    summary: 'Get database details, connection info, and live cluster health',
    scope: 'read',
    response: databaseDetailSchema
  },
  'DELETE /databases/:id': {
    summary: 'Delete a database and destroy all its data',
    scope: 'deploy',
    response: z.object({ success: z.boolean(), message: z.string() }).passthrough()
  },
  'GET /databases/:id/metrics': {
    summary: 'Get CPU, memory, and network time series for a database',
    scope: 'read',
    request: z.object({
      start: z
        .string()
        .optional()
        .describe('Range start in epoch milliseconds. Defaults to end minus 1h.'),
      end: z.string().optional().describe('Range end in epoch milliseconds. Defaults to now.'),
      step: z.string().optional().describe('Step in milliseconds, minimum 1000. Defaults to 30000.')
    }),
    response: metricsResponseSchema
  },
  'GET /databases/:id/provisioning': {
    summary: 'Get step-by-step provisioning status for a database',
    scope: 'read',
    response: provisioningSchema
  },
  'PATCH /databases/:id/resources': {
    summary: 'Update CPU and memory requests for a database',
    scope: 'deploy',
    request: z.object({
      cpuRequestMilli: z.number().int().positive().nullish(),
      memoryRequestBytes: z.number().int().positive().nullish()
    }),
    response: databaseSchema
  },
  'PATCH /databases/:id/storage': {
    summary: 'Expand the storage volume of a database (grow only, max 200Gi)',
    scope: 'deploy',
    request: z.object({
      storageSize: z.string().regex(/^\d+(Mi|Gi|Ti)$/)
    }),
    response: z
      .object({
        previousSize: z.string().nullish(),
        storageSize: z.string(),
        warning: z.string().nullable()
      })
      .passthrough()
  },
  'GET /databases/:id/backups': {
    summary: 'List backups for a database',
    scope: 'read',
    response: z.array(backupSchema)
  },
  'POST /databases/:id/backups': {
    summary: 'Trigger a new database backup (asynchronous)',
    scope: 'deploy',
    request: z.object({
      label: z.string().optional(),
      type: z.enum(['full', 'diff', 'incr']).optional()
    }),
    response: backupSchema
  },
  'POST /databases/:id/restore': {
    summary: 'Restore a database from a backup, replacing all current data',
    scope: 'deploy',
    request: z.object({ backupId: z.string() }),
    response: z.object({ success: z.boolean(), message: z.string() }).passthrough()
  },
  'GET /databases/:id/backup-schedule': {
    summary: 'Get the automated backup schedule for a database',
    scope: 'read',
    response: z.object({ cron: z.string().nullable() }).passthrough()
  },
  'PUT /databases/:id/backup-schedule': {
    summary: 'Set or replace the automated backup schedule (5 or 6 field cron, UTC)',
    scope: 'deploy',
    request: z.object({ cron: z.string() }),
    response: z.object({ cron: z.string() }).passthrough()
  },
  'DELETE /databases/:id/backup-schedule': {
    summary: 'Clear the automated backup schedule for a database',
    scope: 'deploy',
    response: z.object({ success: z.boolean() }).passthrough()
  },
  'GET /databases/:id/extensions': {
    summary: 'List available and installed Postgres extensions',
    scope: 'read',
    response: z
      .object({
        extensions: z.array(extensionSchema),
        sharedPreloadLibraries: z.array(z.string())
      })
      .passthrough()
  },
  'POST /databases/:id/extensions': {
    summary: 'Install a Postgres extension, optionally adding it to shared_preload_libraries',
    scope: 'deploy',
    request: z.object({
      name: z.string(),
      addToPreload: z.boolean().optional()
    }),
    response: z
      .object({
        success: z.boolean(),
        output: z.string(),
        preloadAdded: z.boolean()
      })
      .passthrough()
  },
  'DELETE /databases/:id/extensions/:name': {
    summary: 'Drop a Postgres extension, optionally removing it from shared_preload_libraries',
    scope: 'deploy',
    request: z.object({
      removeFromPreload: z
        .string()
        .optional()
        .describe('Set to "true" to also remove the extension from shared_preload_libraries.')
    }),
    response: z.object({ success: z.boolean(), output: z.string() }).passthrough()
  },
  'GET /databases/:id/settings': {
    summary: 'Get configured Postgres parameters and shared_preload_libraries',
    scope: 'read',
    response: z
      .object({
        parameters: z
          .record(z.string())
          .describe(
            'Only parameters the user has explicitly set. A parameter absent here is sized automatically from the memory limit.'
          ),
        sharedPreloadLibraries: z.array(z.string()),
        backupCompression: z
          .string()
          .nullable()
          .optional()
          .describe('"gzip", "none", or null to derive it from the memory limit.'),
        advisories: z.array(tuningAdvisory).optional()
      })
      .passthrough()
  },
  'PATCH /databases/:id/settings': {
    summary: 'Update Postgres parameters on a database',
    scope: 'deploy',
    request: z.object({
      parameters: z
        .record(z.string())
        .describe(
          'Values are applied as given and never clamped. Omit a key (or send it empty) to hand it back to automatic sizing.'
        ),
      backupCompression: z
        .enum(['gzip', 'none'])
        .nullable()
        .optional()
        .describe('null restores automatic selection based on the memory limit.')
    }),
    response: z
      .object({
        success: z.boolean(),
        parameters: z.record(z.string()),
        backupCompression: z.string().nullable().optional(),
        advisories: z
          .array(tuningAdvisory)
          .optional()
          .describe('Warnings about the values that were just applied. Never a rejection.')
      })
      .passthrough()
  },
  'POST /databases/:id/public': {
    summary: 'Expose a database publicly with TLS on a shared organization IP',
    scope: 'deploy',
    response: z
      .object({
        enabled: z.boolean(),
        host: z.string(),
        ip: z.string().optional(),
        port: z.number(),
        connectionString: z.string()
      })
      .passthrough()
  },
  'DELETE /databases/:id/public': {
    summary: 'Disable public exposure for a database',
    scope: 'deploy',
    response: z.object({ enabled: z.boolean() }).passthrough()
  },
  'GET /projects/:id/databases': {
    summary: 'List databases in a project with live cluster status',
    scope: 'read',
    response: z.array(databaseSchema)
  },
  'POST /projects/:id/databases': {
    summary: 'Create a Postgres database in a project',
    scope: 'deploy',
    request: createDatabaseRequest,
    response: databaseSchema
  }
};
