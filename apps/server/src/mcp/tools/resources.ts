import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path, query } from '../client';
import { json, paginate, text } from './reply';
import { pageInput } from './inputs';

export function registerResourceTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project in an organization. A project groups deployments, databases, and networking.',
      inputSchema: {
        organizationId: z.guid().describe('Organization UUID to create the project in'),
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description')
      }
    },
    async ({ organizationId, name, description }) => {
      const project = await client.post('/projects', { organizationId, name, description });
      return json(project);
    }
  );

  server.registerTool(
    'update_project',
    {
      description: `Update mutable fields on an existing project. Use this to rename a project, change its description, or update its repository URL / icon / background image.
Only the fields you pass are changed. Leave the rest undefined to keep them as-is. The project's slug (URL path) is not affected by a rename.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
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
          .describe('New icon (emoji or image URL, or null to clear)'),
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
      const project = await client.patch(path`/projects/${projectId}`, body);
      return json(project);
    }
  );

  server.registerTool(
    'create_database',
    {
      description: `Create a new Postgres database in a project. Returns the database record with the password masked.
To wire it into an app, call get_database_connection and pass its connectionString to add_env_vars as DATABASE_URL with secret: true, so the credential never sits in a readable env var.

Optionally, pass restoreFromUrl to seed the new database from an existing one. The
cluster will run pg_dump/pg_restore from the source URL during initdb. The URL must
be reachable from the cluster and use the postgres:// or postgresql:// scheme.

Pass environmentId to put the database in that environment, which gives it that environment's own namespace. Without it the database goes into the project's default environment.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        name: z.string().describe('Database display name'),
        environmentId: z
          .guid()
          .optional()
          .describe(
            "Environment UUID to create the database in. Defaults to the project's default environment."
          ),
        pgMajor: z
          .number()
          .int()
          .min(13)
          .max(18)
          .optional()
          .describe('Postgres major version. Defaults to the instance default.'),
        nodePoolId: z
          .guid()
          .optional()
          .describe('Node pool UUID to schedule the database on (see list_node_pools).'),
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
            'Total Postgres instances: 1 primary plus (replicas - 1) read replicas. Defaults to 1. Each instance is a full pod with its own volume and counts against quota, so a value of 3 costs three times the CPU/memory of a single instance. Call get_database_limits for the ceiling on this instance.'
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
      replicas,
      environmentId,
      pgMajor,
      nodePoolId
    }) => {
      const body: Record<string, unknown> = { name };
      if (environmentId) body.environmentId = environmentId;
      if (pgMajor != null) body.pgMajor = pgMajor;
      if (nodePoolId) body.nodePoolId = nodePoolId;
      if (storageSize) body.storageSize = storageSize;
      if (restoreFromUrl) body.restoreFromUrl = restoreFromUrl;
      if (cpuRequestMilli != null) body.cpuRequestMilli = cpuRequestMilli;
      if (memoryRequestBytes != null) body.memoryRequestBytes = memoryRequestBytes;
      if (replicas != null) body.replicas = replicas;
      const database = await client.post(path`/projects/${projectId}/databases`, body);
      return json(database);
    }
  );

  server.registerTool(
    'get_database_connection',
    {
      description: `Reveal a database's credentials: host, port, user, password, database name, the in-cluster connectionString and, when public access is on, publicConnectionString.

This is the only tool that returns the password, and every call is recorded in the audit log as database.credentials.revealed. Prefer piping connectionString straight into add_env_vars (secret: true) over echoing it back to the user. Requires edit access on the project.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const connection = await client.get(path`/databases/${databaseId}/connection`);
      return json(connection);
    }
  );

  server.registerTool(
    'list_database_backups',
    {
      description:
        'List all backups for a database. Each backup has an id, label, type, status, sizeBytes, and timestamps.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        ...pageInput
      }
    },
    async ({ databaseId, limit, cursor }) => {
      const backups = await client.get(path`/databases/${databaseId}/backups`);
      return json(Array.isArray(backups) ? paginate(backups, { limit, cursor }) : backups);
    }
  );

  server.registerTool(
    'create_database_backup',
    {
      description:
        'Trigger a new backup of a database. Runs asynchronously. Poll list_database_backups to check status. Requires the database to be on a CNPG cluster with backups configured.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
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
      const backup = await client.post(path`/databases/${databaseId}/backups`, body);
      return json(backup);
    }
  );

  server.registerTool(
    'enable_database_public',
    {
      description: `Expose a database publicly on a shared organization IP with a unique port and TLS via Let's Encrypt. Returns the public host, port, and connection string.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(path`/databases/${databaseId}/public`, {});
      return json(result);
    }
  );

  server.registerTool(
    'update_database_resources',
    {
      description: `Update CPU and memory requests for an existing database. The database pod will restart briefly to apply the new resources.
The API enforces project, organization, and per-member resource quotas. If the new values exceed your remaining allowance the call returns an error and nothing changes.
Pass null for either field to clear it and fall back to the default.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
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
      const result = await client.patch(path`/databases/${databaseId}/resources`, body);
      return json(result);
    }
  );

  server.registerTool(
    'get_database_limits',
    {
      description:
        'Instance-wide limits for managed databases, currently just maxReplicas: the largest number of Postgres instances a single cluster may run on this Orchard instance. Self-hosters can change it, so read it rather than assuming the default of 5.',
      inputSchema: {}
    },
    async () => {
      const limits = await client.get('/databases/limits');
      return json(limits);
    }
  );

  server.registerTool(
    'scale_database',
    {
      description: `Change how many Postgres instances a database cluster runs: 1 primary plus (replicas - 1) read replicas. The replicas are streaming hot standbys: they serve reads a few milliseconds behind the primary AND act as failover targets, so this buys read scaling and high availability at once. It does not buy write throughput, which is still one primary.
Each instance is a full pod with its own volume, so scaling from 1 to 3 triples the cluster's CPU and memory usage; the API charges the difference against the organization cap and the project owner's member allowance and returns an error if it does not fit. Scaling down is always permitted.
Scaling up is not instant. A new replica has to clone the primary before it reports ready. Reads that must never hit stale data should keep using the "rw" endpoint. See get_database for the rw/ro/r endpoints.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        replicas: z
          .number()
          .int()
          .positive()
          .describe('Total instance count, at least 1. The ceiling comes from get_database_limits.')
      }
    },
    async ({ databaseId, replicas }) => {
      const result = await client.patch(path`/databases/${databaseId}/replicas`, { replicas });
      return json(result);
    }
  );

  server.registerTool(
    'stop_database',
    {
      description: `Hibernate a database: the Postgres instances shut down, the volume and all its data stay. Anything connected to it starts failing immediately.

Use it to park a database you are not using without losing it. \`delete_database\` is the one that destroys data. CNPG-backed databases only. Bring it back with \`start_database\`.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(path`/databases/${databaseId}/stop`);
      return json(result);
    }
  );

  server.registerTool(
    'start_database',
    {
      description:
        'Bring a stopped database back up on its existing volume. It is not immediately connectable. Postgres has to recover and report ready, so poll `get_database` and watch `liveStatus.ready`.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(path`/databases/${databaseId}/start`);
      return json(result);
    }
  );

  server.registerTool(
    'restart_database',
    {
      description:
        'Restart a database cluster. Drops every open connection, so apps talking to it see errors until they reconnect. Use it to apply a setting that needs a restart, or to clear a wedged instance.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(path`/databases/${databaseId}/restart`);
      return json(result);
    }
  );

  server.registerTool(
    'rename_database',
    {
      description:
        'Rename a database. This is the Orchard display name only. The Postgres database name, cluster name, credentials and connection endpoints are unchanged, so nothing connected to it needs updating.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        name: z.string().describe('The new name')
      }
    },
    async ({ databaseId, name }) => {
      const result = await client.patch(path`/databases/${databaseId}/name`, { name });
      return json(result);
    }
  );

  server.registerTool(
    'get_database_query_stats',
    {
      description: `The slowest queries on a database, from \`pg_stat_statements\`: normalised query text, call count, total and mean execution time, rows.

The first stop for "the database is slow". It tells you which statement is actually spending the time. Requires the \`pg_stat_statements\` extension; install it with \`install_database_extension\` (\`addToPreload: true\`, which needs a restart) if the call comes back empty. Cached for 15s server-side, so polling it in a tight loop tells you nothing new.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(path`/databases/${databaseId}/query-stats`);
      return json(result);
    }
  );

  server.registerTool(
    'reset_database_query_stats',
    {
      description:
        'Zero the pg_stat_statements counters so the next `get_database_query_stats` measures only what happens from now on. Use it to isolate the cost of one workload instead of reading lifetime totals.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.post(path`/databases/${databaseId}/query-stats/reset`);
      return json(result);
    }
  );

  server.registerTool(
    'expand_database_storage',
    {
      description: `Expand the storage volume of a CNPG database. Storage can ONLY grow, never shrink. Requests smaller than the current size are rejected. Expansion happens online: the cluster spec and every data volume are resized directly, so it works even while the database is crashlooping on a full disk or stopped; the filesystem grows within a couple of minutes and CNPG boots the instance once headroom exists. Re-requesting the current size is allowed and re-syncs any volume that lags behind the cluster spec. Maximum size is 200Gi.
IMPORTANT: if the disk filled because WAL archiving is failing, expansion only buys time. Postgres cannot recycle WAL while archiving fails, so the volume WILL fill again. The response includes a "warning" field when the cluster's ContinuousArchiving condition is failing; if present, surface it to the user and treat fixing the archiving config as the real remediation.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        storageSize: z
          .string()
          .regex(/^\d+(Mi|Gi|Ti)$/)
          .describe(
            'New volume size as a Kubernetes quantity, e.g. "10Gi". Must be larger than the current size.'
          )
      }
    },
    async ({ databaseId, storageSize }) => {
      const result = await client.patch(path`/databases/${databaseId}/storage`, { storageSize });
      return json(result);
    }
  );

  server.registerTool(
    'list_database_extensions',
    {
      description:
        'List Postgres extensions available on the database and which are currently installed. Also returns the current shared_preload_libraries.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(path`/databases/${databaseId}/extensions`);
      return json(result);
    }
  );

  server.registerTool(
    'install_database_extension',
    {
      description: `Install a Postgres extension on a CNPG database. Some extensions (like pg_stat_statements) require addToPreload=true, which adds them to shared_preload_libraries and triggers a database restart.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
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
      const result = await client.post(path`/databases/${databaseId}/extensions`, {
        name,
        ...(addToPreload != null && { addToPreload })
      });
      return json(result);
    }
  );

  server.registerTool(
    'uninstall_database_extension',
    {
      description: `DROP a Postgres extension from a database. Objects that depend on it will also be dropped. Optionally remove it from shared_preload_libraries.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        name: z.string().describe('Extension name to drop'),
        removeFromPreload: z
          .boolean()
          .optional()
          .describe('Also remove from shared_preload_libraries. Causes a database restart.')
      }
    },
    async ({ databaseId, name, removeFromPreload }) => {
      const result = await client.delete(
        path`/databases/${databaseId}/extensions/${name}` +
          query({ removeFromPreload: removeFromPreload ? 'true' : undefined })
      );
      return json(result);
    }
  );

  server.registerTool(
    'get_database_settings',
    {
      description: `Read the configured Postgres parameters for a database (max_connections, shared_buffers, work_mem, statement_timeout, synchronous_commit, etc.).

\`parameters\` contains ONLY what the user has explicitly set. A key that is absent is sized automatically from the database's memory limit, so an absent shared_buffers is not "unset", it is managed. \`advisories\` lists settings that were accepted but look dangerous at the current memory limit; check it when diagnosing an OOMKilled database.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(path`/databases/${databaseId}/settings`);
      return json(result);
    }
  );

  server.registerTool(
    'update_database_settings',
    {
      description: `Update Postgres parameters on a database. Some parameters (max_connections, shared_buffers) require a brief database restart to take effect. The API applies them and rolls the pod automatically.
Pass values as strings (e.g. "256MB", "200", "off"). Use get_database_settings first to see current values and supported keys.

The map REPLACES the set of user-set parameters, so omitting a key hands it back to automatic sizing rather than leaving it alone. Send the full map you want.

Values are applied exactly as given and are never clamped, but a dangerous one comes back in \`advisories\`. In particular, do not set shared_buffers anywhere near the memory limit: Postgres reserves it up front, and a base backup then has nowhere to run and OOMKills the database. Leaving shared_buffers out is usually the right answer.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
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
      const result = await client.patch(path`/databases/${databaseId}/settings`, {
        parameters,
        ...(backupCompression !== undefined ? { backupCompression } : {})
      });
      return json(result);
    }
  );

  server.registerTool(
    'get_database_backup_schedule',
    {
      description:
        'Read the current automated backup schedule (cron expression) for a database, or null if none is configured.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const result = await client.get(path`/databases/${databaseId}/backup-schedule`);
      return json(result);
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
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        cron: z.string().describe('5-field cron expression in UTC')
      }
    },
    async ({ databaseId, cron }) => {
      const result = await client.put(path`/databases/${databaseId}/backup-schedule`, { cron });
      return json(result);
    }
  );

  server.registerTool(
    'clear_database_backup_schedule',
    {
      description:
        'Turn off automated backups for a database. This also stops WAL archiving, so point-in-time recovery ends at this moment until a schedule is set again. Backups already taken are kept.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      await client.delete(path`/databases/${databaseId}/backup-schedule`);
      return text('Backup schedule cleared.');
    }
  );

  server.registerTool(
    'disable_database_public',
    {
      description:
        'Stop exposing a database publicly. Clients connected via the public endpoint will be disconnected. The internal cluster connection still works.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      await client.delete(path`/databases/${databaseId}/public`);
      return text('Public access disabled.');
    }
  );

  server.registerTool(
    'create_template',
    {
      description:
        'Create a custom template from a YAML definition. Use get_template_yaml_guide to see the full format specification.',
      inputSchema: {
        yaml: z.string().describe('The full YAML template definition following the leaf/v1 format')
      }
    },
    async ({ yaml }) => {
      const template = await client.post('/templates', { yaml });
      return json(template);
    }
  );

  server.registerTool(
    'update_template',
    {
      description:
        'Update an existing custom template with a new YAML definition. Built-in templates cannot be updated.',
      inputSchema: {
        templateId: z.guid().describe('The template UUID to update'),
        yaml: z.string().describe('The updated YAML template definition')
      }
    },
    async ({ templateId, yaml }) => {
      const template = await client.put(path`/templates/${templateId}`, { yaml });
      return json(template);
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
      inputSchema: {
        projectId: z.guid().describe('The project UUID to deploy the template into'),
        templateId: z.guid().describe('The template UUID to deploy'),
        parameters: z
          .record(z.string(), z.any())
          .describe(
            'Parameter values as a JSON object, e.g. { "appName": "my-app", "image": "nginx:latest", "port": 3000 }'
          )
      }
    },
    async ({ projectId, templateId, parameters }) => {
      const instance = await client.post(path`/projects/${projectId}/template-instances`, {
        templateId,
        parameters
      });
      return json(instance);
    }
  );
}
