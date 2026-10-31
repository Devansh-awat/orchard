import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path, query } from '../client';
import { failure, json, paginate } from './reply';
import { pageInput } from './inputs';

export function registerDatabaseRecoveryTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'diagnose_database',
    {
      description: `The one call to understand a database. Returns a health verdict (healthy, degraded, unprotected, down, hibernated or unknown) with the reasons behind it, instance readiness, the last restart and why, storage fill and WAL backlog, backups and the recovery window, the last restore test, checkpoints, protection settings, the connection pooler, recent operations and a tail of the Postgres log.

Start here for any database question before reaching for the narrower tools. Find a databaseId with find (kinds: ["database"]).`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const diagnosis = await client.get(path`/databases/${databaseId}/diagnosis`);
      return json(diagnosis);
    }
  );

  server.registerTool(
    'get_database_activity',
    {
      description: `What a database is doing right now: every session with its user, application, client, state, wait event, transaction and query age and the query text, plus which sessions are blocked and by whom, and max_connections.

Use it for "the database is stuck", lock waits, or running out of connections. It shows live query text, so it needs edit access.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const activity = await client.get(path`/databases/${databaseId}/activity`);
      return json(activity);
    }
  );

  server.registerTool(
    'get_database_recovery_window',
    {
      description: `How far back a database can be restored: the earliest and latest recoverable times, whether WAL archiving is healthy, the backups and checkpoints inside the window, recent restore tests, operations in flight, and its protection settings.

Read this before restore_database or fork_database with an at time, so the time you pick is actually recoverable.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const recovery = await client.get(path`/databases/${databaseId}/recovery`);
      return json(recovery);
    }
  );

  server.registerTool(
    'fork_database',
    {
      description: `Copy a database into a new one and leave the original untouched. This is the safe way to try a migration or a risky query on real data first: fork, point a test at the fork, and delete it when done.

at "now" (the default) copies the live database, "latest" uses the newest archived point, or pass an ISO time inside the recovery window. Pass checkpointId or backupId instead to fork from one of those. The new database shows status "restoring" and then "ready". Returns the operation; poll it with get_database_operation (wait: true).`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID to copy'),
        name: z
          .string()
          .optional()
          .describe('Name for the new database. Defaults to "<name>-fork".'),
        environmentId: z
          .guid()
          .optional()
          .describe("Environment for the new database. Defaults to the source database's."),
        at: z.string().optional().describe('"now" (default), "latest", or an ISO 8601 timestamp'),
        checkpointId: z.guid().optional().describe('Fork from this checkpoint'),
        backupId: z.guid().optional().describe('Fork from this backup')
      }
    },
    async ({ databaseId, name, environmentId, at, checkpointId, backupId }) => {
      const targets = [at, checkpointId, backupId].filter((value) => value !== undefined);
      if (targets.length > 1) {
        return failure('Error: Pass at most one of at, checkpointId or backupId.');
      }
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (environmentId) body.environmentId = environmentId;
      if (at) body.at = at;
      if (checkpointId) body.checkpointId = checkpointId;
      if (backupId) body.backupId = backupId;
      const operation = await client.post(path`/databases/${databaseId}/fork`, body);
      return json(operation);
    }
  );

  server.registerTool(
    'create_checkpoint',
    {
      description: `Take an instant named restore point. Take one before a migration, a bulk update or anything you might want to undo.

Pass databaseId for one database, or pin many at once with projectId, environmentId or databaseIds; a bulk call returns a groupId that restore_checkpoint can restore together. A checkpoint becomes restorable once its status is "durable", usually within seconds. Checkpoints are kept for 30 days.`,
      inputSchema: {
        databaseId: z.guid().optional().describe('Checkpoint this one database'),
        databaseIds: z.array(z.guid()).optional().describe('Checkpoint these databases together'),
        projectId: z.guid().optional().describe('Checkpoint every database in this project'),
        environmentId: z
          .guid()
          .optional()
          .describe('Checkpoint every database in this environment'),
        label: z.string().optional().describe('Human-readable label, e.g. "before users migration"')
      }
    },
    async ({ databaseId, databaseIds, projectId, environmentId, label }) => {
      if (databaseId) {
        const checkpoint = await client.post(path`/databases/${databaseId}/checkpoints`, {
          ...(label ? { label } : {})
        });
        return json(checkpoint);
      }
      if (!databaseIds?.length && !projectId && !environmentId) {
        return failure(
          'Error: Pass databaseId, databaseIds, projectId or environmentId to choose what to checkpoint.'
        );
      }
      const body: Record<string, unknown> = {};
      if (databaseIds?.length) body.databaseIds = databaseIds;
      if (projectId) body.projectId = projectId;
      if (environmentId) body.environmentId = environmentId;
      if (label) body.label = label;
      const group = await client.post('/checkpoints', body);
      return json(group);
    }
  );

  server.registerTool(
    'list_checkpoints',
    {
      description:
        'List restore points for a database, newest first. Each has an id, groupId, label, kind (manual, pre_deploy, pre_op, or ddl for ones taken automatically before a DROP), status (only "durable" can be restored), and for ddl checkpoints a detail of what was dropped and by whom.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        ...pageInput
      }
    },
    async ({ databaseId, limit, cursor }) => {
      const checkpoints = await client.get(path`/databases/${databaseId}/checkpoints`);
      return json(
        Array.isArray(checkpoints) ? paginate(checkpoints, { limit, cursor }) : checkpoints
      );
    }
  );

  server.registerTool(
    'get_database_operation',
    {
      description: `Read a database operation (restore, fork, undelete or restore test): status (pending, running, succeeded, failed), phase, target, result and error.

Pass wait: true to long-poll for up to 25s while it is still running instead of polling in a tight loop.`,
      inputSchema: {
        operationId: z.guid().describe('The operation UUID'),
        wait: z.boolean().optional().describe('Block up to 25s while the operation is running')
      }
    },
    async ({ operationId, wait }) => {
      const operation = await client.get(
        path`/database-operations/${operationId}` + query({ wait: wait ? '1' : undefined })
      );
      return json(operation);
    }
  );

  server.registerTool(
    'list_database_operations',
    {
      description:
        'List restores, forks, undeletes and restore tests that involved a database, newest first.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        ...pageInput
      }
    },
    async ({ databaseId, limit, cursor }) => {
      const operations = await client.get(path`/databases/${databaseId}/operations`);
      return json(Array.isArray(operations) ? paginate(operations, { limit, cursor }) : operations);
    }
  );

  server.registerTool(
    'cancel_database_operation',
    {
      description:
        'Cancel a database operation that is still pending or running. Any half-made copy is cleaned up and the original database is not touched. Once it reaches the cutting_over or finalizing phase it can no longer be cancelled.',
      inputSchema: {
        operationId: z.guid().describe('The operation UUID')
      }
    },
    async ({ operationId }) => {
      const operation = await client.post(path`/database-operations/${operationId}/cancel`);
      return json(operation);
    }
  );

  server.registerTool(
    'test_database_backup',
    {
      description:
        'Prove a database can actually be restored: restores its latest backup into a throwaway cluster, checks the tables and row counts against the live database, then deletes the copy. Returns the operation; poll it with get_database_operation and read result.verdict and result.recoveryMs.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const operation = await client.post(path`/databases/${databaseId}/restore-tests`);
      return json(operation);
    }
  );

  server.registerTool(
    'list_database_restore_tests',
    {
      description:
        'List past restore tests for a database, newest first, each with its verdict (passed, missing tables, row drift, reasons) and how long recovery took.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        ...pageInput
      }
    },
    async ({ databaseId, limit, cursor }) => {
      const tests = await client.get(path`/databases/${databaseId}/restore-tests`);
      return json(Array.isArray(tests) ? paginate(tests, { limit, cursor }) : tests);
    }
  );

  server.registerTool(
    'set_database_protection',
    {
      description: `Change a database's safety settings. Only the fields you pass change.
- deletionProtection: true makes delete_database refuse. Turning it off is a separate tool, disable_database_deletion_protection.
- ddlCheckpoints: take a checkpoint automatically before any DROP TABLE, DROP SCHEMA, DROP COLUMN and similar.
- restoreTests: run scheduled restore tests against the latest backup.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        deletionProtection: z.boolean().optional().describe('Only true is accepted here'),
        ddlCheckpoints: z.boolean().optional().describe('Checkpoint before destructive DDL'),
        restoreTests: z.boolean().optional().describe('Run scheduled restore tests')
      }
    },
    async ({ databaseId, deletionProtection, ddlCheckpoints, restoreTests }) => {
      if (deletionProtection === false) {
        return failure(
          'Error: Turning deletion protection off needs disable_database_deletion_protection.'
        );
      }
      const body: Record<string, unknown> = {};
      if (deletionProtection !== undefined) body.deletionProtection = deletionProtection;
      if (ddlCheckpoints !== undefined) body.ddlCheckpoints = ddlCheckpoints;
      if (restoreTests !== undefined) body.restoreTests = restoreTests;
      if (Object.keys(body).length === 0) {
        return failure(
          'Error: Pass at least one of deletionProtection, ddlCheckpoints, restoreTests.'
        );
      }
      const result = await client.patch(path`/databases/${databaseId}/protection`, body);
      return json(result);
    }
  );

  server.registerTool(
    'get_database_pooler',
    {
      description:
        "Read a database's PgBouncer connection pooler: whether it is enabled, its config (instances, poolMode, defaultPoolSize, maxClientConn), the host and port apps should connect to, and whether it is ready.",
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const pooler = await client.get(path`/databases/${databaseId}/pooler`);
      return json(pooler);
    }
  );

  server.registerTool(
    'set_database_pooler',
    {
      description: `Turn a database's PgBouncer connection pooler on or off, or change its config. Only the fields you pass change.

Apps only go through the pooler if they connect to its host and port (see get_database_pooler); the direct endpoint keeps working. Transaction mode packs the most clients into the fewest connections but breaks session state such as prepared statements, advisory locks and SET; use session mode if the app relies on those.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        enabled: z.boolean().optional().describe('Run the pooler'),
        poolMode: z
          .enum(['transaction', 'session'])
          .optional()
          .describe('When a server connection returns to the pool'),
        instances: z.number().int().min(1).max(3).optional().describe('PgBouncer pods, 1 to 3'),
        defaultPoolSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Server connections per user and database pair, 1 to 100'),
        maxClientConn: z
          .number()
          .int()
          .min(10)
          .max(5000)
          .optional()
          .describe('Client connections the pooler accepts, 10 to 5000')
      }
    },
    async ({ databaseId, enabled, poolMode, instances, defaultPoolSize, maxClientConn }) => {
      const body: Record<string, unknown> = {};
      if (enabled !== undefined) body.enabled = enabled;
      if (poolMode) body.poolMode = poolMode;
      if (instances != null) body.instances = instances;
      if (defaultPoolSize != null) body.defaultPoolSize = defaultPoolSize;
      if (maxClientConn != null) body.maxClientConn = maxClientConn;
      const pooler = await client.put(path`/databases/${databaseId}/pooler`, body);
      return json(pooler);
    }
  );

  server.registerTool(
    'list_deleted_databases',
    {
      description:
        "List a project's deleted databases still in the 30-day trash. recoverableUntil is null when the database never had a completed backup, which means it cannot be brought back. Restore one with undelete_database.",
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        ...pageInput
      }
    },
    async ({ projectId, limit, cursor }) => {
      const deleted = await client.get(path`/projects/${projectId}/deleted-databases`);
      return json(Array.isArray(deleted) ? paginate(deleted, { limit, cursor }) : deleted);
    }
  );

  server.registerTool(
    'undelete_database',
    {
      description:
        'Bring a deleted database back from the trash, restored from its backups up to the moment it was deleted. It keeps its id and password but runs on a new cluster, so read get_database_connection afterwards and update DATABASE_URL on the apps that used it. Returns the operation; poll it with get_database_operation.',
      inputSchema: {
        deletedDatabaseId: z.guid().describe('The id from list_deleted_databases'),
        name: z
          .string()
          .optional()
          .describe('Name for the restored database. Defaults to the old name.'),
        environmentId: z
          .guid()
          .optional()
          .describe('Environment to restore it into. Defaults to the one it was deleted from.')
      }
    },
    async ({ deletedDatabaseId, name, environmentId }) => {
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (environmentId) body.environmentId = environmentId;
      const operation = await client.post(
        path`/deleted-databases/${deletedDatabaseId}/restore`,
        body
      );
      return json(operation);
    }
  );

  server.registerTool(
    'get_database_replication',
    {
      description:
        "Read a database's replication mode. async: standbys follow the primary and a failover can lose the last moments of writes. preferred: each commit waits for a standby while one is healthy, and keeps going without it. required: each commit waits for a standby, so no acknowledged write is ever lost, but writes stop if no standby is reachable.",
      inputSchema: { databaseId: z.guid().describe('The database UUID') }
    },
    async ({ databaseId }) => json(await client.get(path`/databases/${databaseId}/replication`))
  );

  server.registerTool(
    'set_database_replication',
    {
      description:
        'Set the replication mode to async, preferred or required (see get_database_replication). preferred and required need at least 2 instances; scale_database first.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        mode: z.enum(['async', 'preferred', 'required']).describe('Replication mode')
      }
    },
    async ({ databaseId, mode }) =>
      json(await client.patch(path`/databases/${databaseId}/replication`, { mode }))
  );

  server.registerTool(
    'list_database_users',
    {
      description:
        'List the extra login users created on a database through Orchard (name and read or write access). The owner user is not listed.',
      inputSchema: { databaseId: z.guid().describe('The database UUID') }
    },
    async ({ databaseId }) => json(await client.get(path`/databases/${databaseId}/users`))
  );

  server.registerTool(
    'create_database_user',
    {
      description:
        'Create an extra login user on a database. access read can read every table (good for BI tools and analytics); write can also insert, update and delete, but cannot change the schema. Returns the password and a connection string once; it is not shown again.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]{1,40}$/)
          .describe('User name: lowercase letters, digits and underscores'),
        access: z.enum(['read', 'write']).optional().describe('read (default) or write')
      }
    },
    async ({ databaseId, name, access }) =>
      json(await client.post(path`/databases/${databaseId}/users`, { name, access }))
  );

  server.registerTool(
    'delete_database_user',
    {
      description: 'Remove an extra login user from a database. Its open connections stop working.',
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        name: z.string().describe('The user name')
      }
    },
    async ({ databaseId, name }) =>
      json(await client.delete(path`/databases/${databaseId}/users/${name}`))
  );

  server.registerTool(
    'list_postgres_versions',
    {
      description:
        'List the Postgres major versions new databases and upgrades can use, straight from the CNPG image catalog (so new majors appear without an Orchard release), with the minor each one rolls to, whether the Postgres project still supports it, its end of life date, and the default for new databases.',
      inputSchema: {}
    },
    async () => json(await client.get('/database-versions'))
  );

  server.registerTool(
    'get_database_security',
    {
      description:
        "Show which known PostgreSQL vulnerabilities (CVEs from postgresql.org) affect a database's running version, with CVSS score, component and the version that fixes each, plus end of life status. action says what to do: none, minor_update (Orchard rolls minor versions automatically, see minorUpdate), or major_upgrade (the major is unsupported or a fix only exists on a newer major; use upgrade_database).",
      inputSchema: { databaseId: z.guid().describe('The database UUID') }
    },
    async ({ databaseId }) => json(await client.get(path`/databases/${databaseId}/security`))
  );
}
