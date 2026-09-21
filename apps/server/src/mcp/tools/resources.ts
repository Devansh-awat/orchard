import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';

export function registerResourceTools(server: McpServer, client: OrchardClient) {
  // ── Projects ──────────────────────────────────────────────────────

  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project in an organization. A project groups deployments, databases, and networking.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().describe('Organization UUID to create the project in'),
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description')
      }
    },
    async ({ organizationId, name, description }) => {
      const project = await client.post('/projects', { organizationId, name, description });
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    }
  );

  server.registerTool(
    'update_project',
    {
      description: `Update mutable fields on an existing project. Use this to rename a project, change its description, or update its repository URL / icon / background image.
Only the fields you pass are changed — leave the rest undefined to keep them as-is. The project's slug (URL path) is not affected by a rename.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().optional().describe('New project name'),
        description: z
          .string()
          .nullable()
          .optional()
          .describe('New project description (pass null to clear)'),
        repositoryUrl: z
          .string()
          .nullable()
          .optional()
          .describe('New repository URL (pass null to clear)'),
        icon: z
          .string()
          .nullable()
          .optional()
          .describe('New icon (emoji or image URL — pass null to clear)'),
        backgroundImage: z
          .string()
          .nullable()
          .optional()
          .describe('New background image URL (pass null to clear)')
      }
    },
    async ({ projectId, name, description, repositoryUrl, icon, backgroundImage }) => {
      const body: Record<string, any> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (repositoryUrl !== undefined) body.repositoryUrl = repositoryUrl;
      if (icon !== undefined) body.icon = icon;
      if (backgroundImage !== undefined) body.backgroundImage = backgroundImage;
      if (Object.keys(body).length === 0) {
        throw new Error(
          'At least one field (name, description, repositoryUrl, icon, backgroundImage) must be provided'
        );
      }
      const project = await client.patch(`/projects/${projectId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    }
  );

  // ── Databases ─────────────────────────────────────────────────────

  server.registerTool(
    'create_database',
    {
      description: `Create a new PostgreSQL database in a project. Returns connection details.
After creating, you can use set_env_vars to set the DATABASE_URL on a deployment.
The DATABASE_URL format is: postgresql://user:password@host:port/dbname

Optionally, pass restoreFromUrl to seed the new database from an existing one — the
cluster will run pg_dump/pg_restore from the source URL during initdb. The URL must
be reachable from the cluster and use the postgres:// or postgresql:// scheme.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
        name: z.string().describe('Database display name'),
        storageSize: z
          .string()
          .regex(/^\d+(Mi|Gi|Ti)$/)
          .optional()
          .describe('Storage size, e.g. "1Gi", "10Gi", "500Mi". Defaults to "1Gi".'),
        restoreFromUrl: z
          .string()
          .optional()
          .describe(
            'Optional postgres:// or postgresql:// URL to migrate data from on first boot (e.g. postgres://user:pass@host:5432/dbname?sslmode=require).'
          ),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('CPU request in millicores (e.g. 500 = 0.5 CPU).'),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Memory request in bytes (e.g. 536870912 = 512Mi).'),
        replicas: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Total PostgreSQL instances: 1 primary plus (replicas - 1) read replicas. Defaults to 1. Each instance is a full pod with its own volume and counts against quota, so a value of 3 costs three times the CPU/memory of a single instance. Call get_database_limits for the ceiling on this instance.'
          )
      }
    },
    async ({
      projectId,
      name,
      storageSize,
      restoreFromUrl,
      cpuRequestMilli,
      memoryRequestBytes,
      replicas
    }) => {
      const body: Record<string, unknown> = { name };
      if (storageSize) body.storageSize = storageSize;
      if (restoreFromUrl) body.restoreFromUrl = restoreFromUrl;
      if (cpuRequestMilli != null) body.cpuRequestMilli = cpuRequestMilli;
      if (memoryRequestBytes != null) body.memoryRequestBytes = memoryRequestBytes;
      if (replicas != null) body.replicas = replicas;
      const database = await client.post(`/projects/${projectId}/databases`, body);
      return { content: [{ type: 'text', text: JSON.stringify(database, null, 2) }] };
    }
  );

  server.registerTool(
    'list_database_backups',
    {
      description:
        'List all backups for a database. Each backup has an id, label, type, status, sizeBytes, and timestamps.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const backups = await client.get(`/databases/${databaseId}/backups`);
      return { content: [{ type: 'text', text: JSON.stringify(backups, null, 2) }] };
    }
  );

  server.registerTool(
    'create_database_backup',
    {
      description:
        'Trigger a new backup of a database. Runs asynchronously — poll list_database_backups to check status. Requires the database to be on a CNPG cluster with backups configured.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        label: z.string().optional().describe('Optional human-readable label for the backup'),
        type: z
          .enum(['full', 'diff', 'incr'])
          .optional()
          .describe('Backup type. Defaults to "full".')
      }
    },
    async ({ databaseId, label, type }) => {
      const body: Record<string, unknown> = {};
      if (label) body.label = label;
      if (type) body.type = type;
      const backup = await client.post(`/databases/${databaseId}/backups`, body);
      return { content: [{ type: 'text', text: JSON.stringify(backup, null, 2) }] };
    }
  );

  server.registerTool(
    'enable_database_public',
    {
      description: `Expose a database publicly on a shared organization IP with a unique port and TLS via Let's Encrypt. Returns the public host, port, and connection string.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(`/databases/${databaseId}/public`, {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'update_database_resources',
    {
      description: `Update CPU and memory requests for an existing database. The database pod will restart briefly to apply the new resources.
The API enforces project, organization, and per-member resource quotas — if the new values exceed your remaining allowance the call returns an error and nothing changes.
Pass null for either field to clear it and fall back to the default.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        cpuRequestMilli: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('New CPU request in millicores, or null to clear.'),
        memoryRequestBytes: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('New memory request in bytes, or null to clear.')
      }
    },
    async ({ databaseId, cpuRequestMilli, memoryRequestBytes }) => {
      const body: Record<string, unknown> = {};
      if (cpuRequestMilli !== undefined) body.cpuRequestMilli = cpuRequestMilli;
      if (memoryRequestBytes !== undefined) body.memoryRequestBytes = memoryRequestBytes;
      const result = await client.patch(`/databases/${databaseId}/resources`, body);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_database_limits',
    {
      description:
        'Instance-wide limits for managed databases, currently just maxReplicas — the largest number of PostgreSQL instances a single cluster may run on this Orchard instance. Self-hosters can change it, so read it rather than assuming the default of 5.',
      annotations: { readOnlyHint: true },
      inputSchema: {}
    },
    async () => {
      const limits = await client.get('/databases/limits');
      return { content: [{ type: 'text', text: JSON.stringify(limits, null, 2) }] };
    }
  );

  server.registerTool(
    'scale_database',
    {
      description: `Change how many PostgreSQL instances a database cluster runs: 1 primary plus (replicas - 1) read replicas. The replicas are streaming hot standbys: they serve reads a few milliseconds behind the primary AND act as failover targets, so this buys read scaling and high availability at once. It does not buy write throughput, which is still one primary.
Each instance is a full pod with its own volume, so scaling from 1 to 3 triples the cluster's CPU and memory usage; the API charges the difference against the organization cap and the project owner's member allowance and returns an error if it does not fit. Scaling down is always permitted.
Scaling up is not instant — a new replica has to clone the primary before it reports ready. Reads that must never hit stale data should keep using the "rw" endpoint. See get_database for the rw/ro/r endpoints.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        replicas: z
          .number()
          .int()
          .positive()
          .describe('Total instance count, at least 1. The ceiling comes from get_database_limits.')
      }
    },
    async ({ databaseId, replicas }) => {
      const result = await client.patch(`/databases/${databaseId}/replicas`, { replicas });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'stop_database',
    {
      description: `Hibernate a database: the Postgres instances shut down, the volume and all its data stay. Anything connected to it starts failing immediately.

Use it to park a database you are not using without losing it — \`delete_database\` is the one that destroys data. CNPG-backed databases only. Bring it back with \`start_database\`.`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(`/databases/${databaseId}/stop`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'start_database',
    {
      description:
        'Bring a stopped database back up on its existing volume. It is not immediately connectable — Postgres has to recover and report ready, so poll `get_database` and watch `liveStatus.ready`.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(`/databases/${databaseId}/start`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'restart_database',
    {
      description:
        'Restart a database cluster. Drops every open connection, so apps talking to it see errors until they reconnect. Use it to apply a setting that needs a restart, or to clear a wedged instance.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(`/databases/${databaseId}/restart`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'rename_database',
    {
      description:
        'Rename a database. This is the Orchard display name only — the Postgres database name, cluster name, credentials and connection endpoints are unchanged, so nothing connected to it needs updating.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        name: z.string().describe('The new name')
      }
    },
    async ({ databaseId, name }) => {
      const result = await client.patch(`/databases/${databaseId}/name`, { name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_database_query_stats',
    {
      description: `The slowest queries on a database, from \`pg_stat_statements\`: normalised query text, call count, total and mean execution time, rows.

The first stop for "the database is slow" — it tells you which statement is actually spending the time. Requires the \`pg_stat_statements\` extension; install it with \`install_database_extension\` (\`addToPreload: true\`, which needs a restart) if the call comes back empty. Cached for 15s server-side, so polling it in a tight loop tells you nothing new.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(`/databases/${databaseId}/query-stats`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'reset_database_query_stats',
    {
      description:
        'Zero the pg_stat_statements counters so the next `get_database_query_stats` measures only what happens from now on. Use it to isolate the cost of one workload instead of reading lifetime totals.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(`/databases/${databaseId}/query-stats/reset`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'expand_database_storage',
    {
      description: `Expand the storage volume of a CNPG database. Storage can ONLY grow, never shrink — requests smaller than or equal to the current size are rejected. Expansion happens online (Longhorn resizes the volume in place); if the database was down due to a full disk, CNPG restarts it once headroom is available. Maximum size is 200Gi.
IMPORTANT: if the disk filled because WAL archiving is failing, expansion only buys time — PostgreSQL cannot recycle WAL while archiving fails, so the volume WILL fill again. The response includes a "warning" field when the cluster's ContinuousArchiving condition is failing; if present, surface it to the user and treat fixing the archiving config as the real remediation.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        storageSize: z
          .string()
          .regex(/^\d+(Mi|Gi|Ti)$/)
          .describe(
            'New volume size as a Kubernetes quantity, e.g. "10Gi". Must be larger than the current size.'
          )
      }
    },
    async ({ databaseId, storageSize }) => {
      const result = await client.patch(`/databases/${databaseId}/storage`, { storageSize });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'list_database_extensions',
    {
      description:
        'List PostgreSQL extensions available on the database and which are currently installed. Also returns the current shared_preload_libraries.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(`/databases/${databaseId}/extensions`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'install_database_extension',
    {
      description: `Install a PostgreSQL extension on a CNPG database. Some extensions (like pg_stat_statements) require addToPreload=true, which adds them to shared_preload_libraries and triggers a database restart.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        name: z
          .string()
          .describe('Extension name (e.g. "pgcrypto", "uuid-ossp", "pg_stat_statements")'),
        addToPreload: z
          .boolean()
          .optional()
          .describe(
            'Add to shared_preload_libraries. Required for some extensions; causes a database restart.'
          )
      }
    },
    async ({ databaseId, name, addToPreload }) => {
      const result = await client.post(`/databases/${databaseId}/extensions`, {
        name,
        ...(addToPreload != null && { addToPreload })
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'uninstall_database_extension',
    {
      description: `DROP a PostgreSQL extension from a database. Objects that depend on it will also be dropped. Optionally remove it from shared_preload_libraries.`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        name: z.string().describe('Extension name to drop'),
        removeFromPreload: z
          .boolean()
          .optional()
          .describe('Also remove from shared_preload_libraries. Causes a database restart.')
      }
    },
    async ({ databaseId, name, removeFromPreload }) => {
      const qs = removeFromPreload ? '?removeFromPreload=true' : '';
      const result = await client.delete(
        `/databases/${databaseId}/extensions/${encodeURIComponent(name)}${qs}`
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_database_settings',
    {
      description: `Read the configured PostgreSQL parameters for a database (max_connections, shared_buffers, work_mem, statement_timeout, synchronous_commit, etc.).

\`parameters\` contains ONLY what the user has explicitly set. A key that is absent is sized automatically from the database's memory limit, so an absent shared_buffers is not "unset", it is managed. \`advisories\` lists settings that were accepted but look dangerous at the current memory limit; check it when diagnosing an OOMKilled database.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(`/databases/${databaseId}/settings`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'update_database_settings',
    {
      description: `Update PostgreSQL parameters on a database. Some parameters (max_connections, shared_buffers) require a brief database restart to take effect — the API applies them and rolls the pod automatically.
Pass values as strings (e.g. "256MB", "200", "off"). Use get_database_settings first to see current values and supported keys.

The map REPLACES the set of user-set parameters, so omitting a key hands it back to automatic sizing rather than leaving it alone. Send the full map you want.

Values are applied exactly as given and are never clamped, but a dangerous one comes back in \`advisories\`. In particular, do not set shared_buffers anywhere near the memory limit: Postgres reserves it up front, and a base backup then has nowhere to run and OOMKills the database. Leaving shared_buffers out is usually the right answer.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        parameters: z
          .record(z.string(), z.string())
          .describe(
            'Parameter map, e.g. { "max_connections": "200", "work_mem": "16MB", "log_min_duration_statement": "1000" }'
          ),
        backupCompression: z
          .enum(['gzip', 'none'])
          .nullable()
          .optional()
          .describe(
            'Compression for the base backup. Omit or null to pick it from the memory limit, which is almost always what you want: gzip on a small database can OOMKill it mid-backup.'
          )
      }
    },
    async ({ databaseId, parameters, backupCompression }) => {
      const result = await client.patch(`/databases/${databaseId}/settings`, {
        parameters,
        ...(backupCompression !== undefined ? { backupCompression } : {})
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'get_database_backup_schedule',
    {
      description:
        'Read the current automated backup schedule (cron expression) for a database, or null if none is configured.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(`/databases/${databaseId}/backup-schedule`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'set_database_backup_schedule',
    {
      description: `Set or replace the automated backup schedule for a database, using a standard 5-field cron expression in UTC.
Common values:
- "0 * * * *"     hourly
- "0 */6 * * *"   every 6 hours
- "0 2 * * *"     daily at 02:00 UTC
- "0 2 * * 0"     weekly Sunday 02:00 UTC`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        cron: z.string().describe('5-field cron expression in UTC')
      }
    },
    async ({ databaseId, cron }) => {
      const result = await client.put(`/databases/${databaseId}/backup-schedule`, { cron });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    'clear_database_backup_schedule',
    {
      description:
        'Disable automated backups for a database (clears the cron schedule). Existing backups are kept.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      await client.delete(`/databases/${databaseId}/backup-schedule`);
      return { content: [{ type: 'text', text: 'Backup schedule cleared.' }] };
    }
  );

  server.registerTool(
    'disable_database_public',
    {
      description:
        'Stop exposing a database publicly. Clients connected via the public endpoint will be disconnected. The internal cluster connection still works.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      await client.delete(`/databases/${databaseId}/public`);
      return { content: [{ type: 'text', text: 'Public access disabled.' }] };
    }
  );

  // ── Templates ─────────────────────────────────────────────────────

  server.registerTool(
    'create_template',
    {
      description:
        'Create a custom template from a YAML definition. Use get_template_yaml_guide to see the full format specification.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        yaml: z.string().describe('The full YAML template definition following the leaf/v1 format')
      }
    },
    async ({ yaml }) => {
      const template = await client.post('/templates', { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    }
  );

  server.registerTool(
    'update_template',
    {
      description:
        'Update an existing custom template with a new YAML definition. Built-in templates cannot be updated.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        templateId: z.string().describe('The template UUID to update'),
        yaml: z.string().describe('The updated YAML template definition')
      }
    },
    async ({ templateId, yaml }) => {
      const template = await client.put(`/templates/${templateId}`, { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    }
  );

  server.registerTool(
    'deploy_template',
    {
      description: `Deploy a template to a project. This creates all the resources defined in the template (databases, deployments, ingresses) with the provided parameter values.

Before using this tool:
1. Use list_templates to find available templates
2. Use get_template to see the required parameters
3. Provide all required parameters as a JSON object

The template engine will validate parameters and create resources in order, wiring them together automatically (e.g. DATABASE_URL is set on the deployment from the created database).`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID to deploy the template into'),
        templateId: z.string().describe('The template UUID to deploy'),
        parameters: z
          .record(z.string(), z.any())
          .describe(
            'Parameter values as a JSON object, e.g. { "appName": "my-app", "image": "nginx:latest", "port": 3000 }'
          )
      }
    },
    async ({ projectId, templateId, parameters }) => {
      const instance = await client.post(`/projects/${projectId}/template-instances`, {
        templateId,
        parameters
      });
      return { content: [{ type: 'text', text: JSON.stringify(instance, null, 2) }] };
    }
  );
}
