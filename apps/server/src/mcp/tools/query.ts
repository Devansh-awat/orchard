import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OrchardClient, path, query as toQuery } from '../client';
import { capLines, capText, failure, json, paginate, structured, text } from './reply';
import { pageInput } from './inputs';
import { deploymentOutput, findOutput, pageOutput } from './outputs';

export const YAML_FORMAT_GUIDE = `
## Leaf Template YAML Format

Templates use \`apiVersion: leaf/v1\` and \`kind: Template\`.

### Structure

\`\`\`yaml
apiVersion: leaf/v1
kind: Template

metadata:
  name: my-template           # unique, lowercase alphanumeric + hyphens
  displayName: My Template    # human-readable name
  description: What it does   # optional
  icon: nodejs                # optional icon identifier
  version: "1.0.0"           # optional, defaults to 1.0.0
  category: backend           # optional: backend, frontend, cms, database, etc.
  tags: ["tag1", "tag2"]     # optional

parameters:                   # user-configurable inputs
  - name: paramName           # variable name, referenced as {{ params.paramName }}
    displayName: Param Label
    description: Help text
    type: string              # string | number | boolean | select | secret
    default: value            # optional default
    required: true            # defaults to false
    placeholder: hint         # optional
    validation:               # optional
      pattern: "^regex$"      # for strings
      message: "error msg"
      min: 1                  # for numbers / min length for secrets
      max: 100                # for numbers / max length for secrets

resources:                    # infrastructure to create (order matters!)
  - name: resourceName        # referenced as {{ resources.resourceName.field }}
    type: deployment          # deployment | database | ingress
    config: { ... }           # type-specific config
\`\`\`

### Resource Types

**database**: Creates a Postgres database.
Available context fields: id, host, port, dbName, dbUser, dbPassword, connectionString
\`\`\`yaml
- name: db
  type: database
  config:
    name: "{{ params.appName }}-db"
\`\`\`

**deployment**: Creates a container deployment.
Available context fields: id, serviceName
\`\`\`yaml
- name: app
  type: deployment
  config:
    name: "{{ params.appName }}"
    image: "{{ params.image }}"
    replicas: "{{ params.replicas }}"
    ports:
      - name: http
        containerPort: "{{ params.port }}"
        servicePort: "{{ params.port }}"
        protocol: TCP
    env:
      - key: DATABASE_URL
        value: "{{ resources.db.connectionString }}"
    volumes:                          # optional
      - name: data
        type: pvc                     # pvc | hostPath | emptyDir
        mountPath: /data
        pvcName: my-pvc
        storageSize: 1Gi              # default: 1Gi
    exposePublic: true                # optional, external Service (NodePort), does not remove a domain's login
\`\`\`

**ingress**: Creates a public domain route.
Available context fields: id, host
\`\`\`yaml
- name: web
  type: ingress
  config:
    host: "{{ params.domain }}"
    tlsEnabled: true
    routes:
      - path: /
        serviceName: "{{ resources.app.serviceName }}"
        servicePort: "{{ params.port }}"
    basicAuth:                        # optional
      enabled: true
      username: admin
      password: secret
\`\`\`

### Interpolation

- \`{{ params.paramName }}\`: inserts a parameter value
- \`{{ resources.resourceName.field }}\`: references a previously created resource
- Resources are created in order, so a deployment can reference a database created before it

### Example: Full-stack Node.js + Postgres

\`\`\`yaml
apiVersion: leaf/v1
kind: Template
metadata:
  name: nodejs-postgres
  displayName: Node.js + Postgres
  description: A Node.js app with a Postgres database and public ingress.
  icon: nodejs
  category: backend
  tags: ["nodejs", "postgres", "api"]

parameters:
  - name: appName
    displayName: App Name
    type: string
    default: my-app
    required: true
    validation:
      pattern: "^[a-z][a-z0-9-]{1,58}[a-z0-9]$"
      message: Lowercase alphanumeric with hyphens, 3-60 chars

  - name: image
    displayName: Docker Image
    type: string
    required: true
    placeholder: "ghcr.io/user/app:latest"

  - name: port
    displayName: App Port
    type: number
    default: 3000
    validation:
      min: 1
      max: 65535

  - name: replicas
    displayName: Replicas
    type: number
    default: 1
    validation:
      min: 1
      max: 10

  - name: domain
    displayName: Domain
    type: string
    required: true
    placeholder: "api.example.com"

  - name: dbPassword
    displayName: Database Password
    type: secret             # auto-generates a strong password if not provided
    validation:
      min: 16                # minimum length (default: 32)

  - name: enableTls
    displayName: Enable HTTPS
    type: boolean
    default: true

resources:
  - name: db
    type: database
    config:
      name: "{{ params.appName }}-db"

  - name: app
    type: deployment
    config:
      name: "{{ params.appName }}"
      image: "{{ params.image }}"
      replicas: "{{ params.replicas }}"
      ports:
        - name: http
          containerPort: "{{ params.port }}"
          servicePort: "{{ params.port }}"
          protocol: TCP
      env:
        - key: DATABASE_URL
          value: "{{ resources.db.connectionString }}"
        - key: PORT
          value: "{{ params.port }}"
        - key: NODE_ENV
          value: production

  - name: ingress
    type: ingress
    config:
      host: "{{ params.domain }}"
      tlsEnabled: "{{ params.enableTls }}"
      routes:
        - path: /
          serviceName: "{{ resources.app.serviceName }}"
          servicePort: "{{ params.port }}"
\`\`\`
`;

export function registerQueryTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_current_user',
    {
      description: "Get the currently authenticated user's profile information",
      inputSchema: {}
    },
    async () => {
      const user = await client.get('/auth/me');
      return json(user);
    }
  );

  server.registerTool(
    'list_organizations',
    {
      description: 'List all organizations the authenticated user belongs to',
      inputSchema: {}
    },
    async () => {
      const orgs = await client.get('/organizations/user');
      return json(orgs);
    }
  );

  server.registerTool(
    'find',
    {
      description: `Turn a name into a UUID. **Start here** whenever the user names something ("restart hackatime", "the leaf db") instead of walking list_organizations → list_projects → list_deployments.

Searches organizations, projects, deployments and databases at once and returns compact matches with the ids every other tool wants. Matching is case-insensitive substring over names, slugs, GitHub repos and ingress hosts. Call it with no query to get an inventory of everything the user can see.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Substring to match. Omit to return everything the user can see.'),
        kinds: z
          .array(z.enum(['organization', 'project', 'deployment', 'database']))
          .max(20)
          .optional()
          .describe('Restrict the search to these kinds. Default: all four.'),
        organizationId: z.guid().optional().describe('Restrict the search to one organization')
      },
      outputSchema: findOutput
    },
    async ({ query, kinds, organizationId }) => {
      const wanted = new Set(kinds ?? ['organization', 'project', 'deployment', 'database']);
      const orgQs = toQuery({ orgId: organizationId });
      const needle = (query ?? '').trim().toLowerCase();
      const hit = (...fields: unknown[]) =>
        !needle || fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));

      const errors: { kind: string; error: string }[] = [];
      const fetchKind = (kind: string, route: string) =>
        wanted.has(kind)
          ? client.get(route).catch((err: unknown) => {
              errors.push({ kind, error: err instanceof Error ? err.message : String(err) });
              return [];
            })
          : Promise.resolve([]);
      const [orgs, projects, deployments, databases] = await Promise.all([
        fetchKind('organization', '/organizations/user'),
        fetchKind('project', `/projects${orgQs}`),
        fetchKind('deployment', `/deployments${orgQs}`),
        fetchKind('database', `/databases${orgQs}`)
      ]);

      const hostsOf = (d: any): string[] => [
        ...(d.ingresses ?? []).map((i: any) => i.host),
        ...(d.services ?? []).flatMap((s: any) => (s.ingresses ?? []).map((i: any) => i.host))
      ];

      const results = [
        ...(Array.isArray(orgs) ? orgs : [])
          .filter((o: any) => hit(o.name, o.slug))
          .map((o: any) => ({
            kind: 'organization',
            id: o.id,
            name: o.name,
            slug: o.slug
          })),
        ...(Array.isArray(projects) ? projects : [])
          .filter((p: any) => organizationId == null || p.organizationId === organizationId)
          .filter((p: any) => hit(p.name, p.slug))
          .map((p: any) => ({
            kind: 'project',
            id: p.id,
            name: p.name,
            slug: p.slug,
            organizationId: p.organizationId
          })),
        ...(Array.isArray(deployments) ? deployments : [])
          .filter((d: any) =>
            hit(
              d.name,
              d.displayName,
              d.githubRepo,
              d.project?.name,
              d.project?.slug,
              ...hostsOf(d)
            )
          )
          .map((d: any) => ({
            kind: 'deployment',
            id: d.id,
            name: d.displayName || d.name,
            status: d.status,
            stopped: d.stopped,
            replicas: d.replicas,
            projectId: d.project?.id,
            projectName: d.project?.name,
            organizationId: d.project?.organizationId,
            githubRepo: d.githubRepo,
            hosts: hostsOf(d).filter(Boolean)
          })),
        ...(Array.isArray(databases) ? databases : [])
          .filter((db: any) => hit(db.name, db.dbName, db.project?.name, db.project?.slug))
          .map((db: any) => ({
            kind: 'database',
            id: db.id,
            name: db.name,
            status: db.status,
            projectId: db.project?.id,
            projectName: db.project?.name,
            organizationId: db.project?.organizationId
          }))
      ];

      return structured({
        query: query ?? null,
        results,
        ...(errors.length ? { partial: true, errors } : {})
      });
    }
  );

  server.registerTool(
    'get_resource_quota',
    {
      description: `How much CPU and memory the caller can still hand out in an organization.

**Check this before sizing anything.** \`create_deployment\`, \`update_deployment_resources\`, \`scale_deployment\`, \`scale_database\` and \`start_deployment\` are all quota-checked server-side and simply fail when the numbers do not fit; this is the only way to know the ceiling in advance instead of guessing and retrying.

\`effectiveLimit\` is the number you want: the most that can go on a single deployment right now, already reduced to \`min(what this member has left, what the org has left)\`. A null means unlimited on that axis. \`allowance\` / \`usage\` / \`orgCap\` show the working.

Units match the resource tools: \`cpuMilli\` in millicores, \`memoryBytes\` in bytes.`,
      inputSchema: {
        organizationId: z
          .guid()
          .describe('The organization UUID (from list_organizations, or find)')
      }
    },
    async ({ organizationId }) => {
      const quota = await client.get(path`/organizations/${organizationId}/quota/me`);
      return json(quota);
    }
  );

  server.registerTool(
    'get_audit_log',
    {
      description: `Who changed what, and when. Pass a deploymentId for one app's history, or an organizationId for everything in the org (org admins only).

This is how you answer "when did this break" and "who turned that off". Each entry records the actor, a timestamp, the action (\`deployment.env.updated\`, \`deployment.scaled\`, \`deployment.stopped\`, \`environment.sharedvars.updated\`, …) and a \`metadata\` object that usually carries the \`[before, after]\` of whatever moved. Paginated: feed \`nextCursor\` back as \`cursor\` for the next page.`,
      inputSchema: {
        deploymentId: z.string().optional().describe("One deployment's history"),
        organizationId: z
          .string()
          .optional()
          .describe('Everything in an organization. Requires org admin.'),
        action: z.string().optional().describe('Filter to one action, e.g. deployment.env.updated'),
        limit: z.number().optional().describe('Entries per page'),
        cursor: z.string().optional().describe('Cursor from a previous page')
      }
    },
    async ({ deploymentId, organizationId, action, limit, cursor }) => {
      if (!deploymentId && !organizationId) {
        throw new Error('Pass either deploymentId or organizationId');
      }
      const base = deploymentId
        ? path`/audit-logs/deployment/${deploymentId}`
        : path`/audit-logs/organization/${organizationId}`;
      const logs = await client.get(base + toQuery({ action, limit, cursor }));
      return json(logs);
    }
  );

  server.registerTool(
    'list_node_pools',
    {
      description: `List the node pools a deployment can be pinned to, for \`update_deployment_placement\` or \`create_deployment\`'s \`nodePoolId\`.

Only pools an administrator marked user-selectable show up. On an instance that has not enabled userspace scheduling the call 404s, which just means placement is not a knob here. Schedule anywhere and move on.`,
      inputSchema: {}
    },
    async () => {
      const pools = await client.get('/node-pools');
      return json(pools);
    }
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List projects. With no arguments this returns every project the user can see across all their organizations, so you do not need to walk `list_organizations` first. Pass an organizationId only to narrow it.',
      inputSchema: {
        organizationId: z.guid().optional().describe('Organization UUID to filter by (optional)'),
        ...pageInput
      },
      outputSchema: pageOutput
    },
    async ({ organizationId, limit, cursor }) => {
      const projects = await client.get('/projects' + toQuery({ orgId: organizationId }));
      return structured({ ...paginate(projects, { limit, cursor }) });
    }
  );

  server.registerTool(
    'get_project',
    {
      description: 'Get project details including deployments, databases, and ingresses',
      inputSchema: {
        projectId: z.guid().describe('The project UUID')
      }
    },
    async ({ projectId }) => {
      const project = await client.get(path`/projects/${projectId}`);
      return json(project);
    }
  );

  server.registerTool(
    'list_deployments',
    {
      description: `List deployments. Pass a projectId for one project's deployments, or nothing at all to get every deployment the user can see (optionally narrowed to one organization).

Use \`find\` instead when you know the app by name and want its UUID.`,
      inputSchema: {
        projectId: z
          .guid()
          .optional()
          .describe('The project UUID. Omit to list across every project the user can see.'),
        organizationId: z
          .string()
          .optional()
          .describe(
            'Narrow the cross-project listing to one organization. Ignored with projectId.'
          ),
        ...pageInput
      },
      outputSchema: pageOutput
    },
    async ({ projectId, organizationId, limit, cursor }) => {
      const deployments = await client.get(
        projectId
          ? path`/projects/${projectId}/deployments`
          : '/deployments' + toQuery({ orgId: organizationId })
      );
      return structured({ ...paginate(deployments, { limit, cursor }) });
    }
  );

  server.registerTool(
    'get_deployment',
    {
      description: `Get deployment details: status, image, replicas, env var names, services, ingresses, volumes, health check, build config, placement and recent image history.

The build log is omitted here because it is often megabytes. Read it with \`get_build_logs\`. Env var values are omitted too; read them with \`get_env_vars\`. Runtime logs are \`get_deployment_logs\`.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      },
      outputSchema: deploymentOutput
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      return structured(deployment ?? {});
    }
  );

  server.registerTool(
    'get_image_history',
    {
      description: 'Get the image version history for a deployment (for rollback purposes)',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const history = await client.get(path`/deployments/${deploymentId}/image-history`);
      return json(history);
    }
  );

  server.registerTool(
    'get_env_vars',
    {
      description: `Get the current environment variables for a deployment.

Secret vars come back with \`secret: true\` and a null value. The value is write-only and never readable. To change one, use \`add_env_vars\`; you do not need to read it first.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      const envVars = deployment.envVars || [];
      return json(envVars);
    }
  );

  server.registerTool(
    'list_ingresses',
    {
      description: 'List all ingresses (public domains/routes) for a deployment',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      const ingresses = deployment.ingresses || [];
      return json(ingresses);
    }
  );

  server.registerTool(
    'get_ingress',
    {
      description: 'Get ingress details',
      inputSchema: {
        ingressId: z.guid().describe('The ingress UUID')
      }
    },
    async ({ ingressId }) => {
      const ingress = await client.get(path`/ingresses/${ingressId}`);
      return json(ingress);
    }
  );

  server.registerTool(
    'validate_dns',
    {
      description:
        "Validate that a domain's DNS is correctly pointed to the Orchard cluster. Run this before creating an ingress.",
      inputSchema: {
        projectId: z
          .guid()
          .describe(
            'The project UUID the domain belongs to (from list_projects, or the projectId on get_deployment)'
          ),
        domain: z.string().describe('The domain to validate (e.g. myapp.example.com)')
      }
    },
    async ({ projectId, domain }) => {
      const result = await client.post('/projects/ingresses/validate-dns', { projectId, domain });
      return json(result);
    }
  );

  server.registerTool(
    'list_services',
    {
      description: 'List services for a deployment (internal networking, load balancers, etc.)',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      const services = deployment.services || [];
      return json(services);
    }
  );

  server.registerTool(
    'list_databases',
    {
      description:
        "List Postgres databases. Pass a projectId for one project's databases, or nothing at all to get every database the user can see (optionally narrowed to one organization). Passwords are never included; use get_database_connection for credentials.",
      inputSchema: {
        projectId: z
          .guid()
          .optional()
          .describe('The project UUID. Omit to list across every project the user can see.'),
        organizationId: z
          .string()
          .optional()
          .describe(
            'Narrow the cross-project listing to one organization. Ignored with projectId.'
          ),
        ...pageInput
      },
      outputSchema: pageOutput
    },
    async ({ projectId, organizationId, limit, cursor }) => {
      const databases = await client.get(
        projectId
          ? path`/projects/${projectId}/databases`
          : '/databases' + toQuery({ orgId: organizationId })
      );
      return structured({ ...paginate(databases, { limit, cursor }) });
    }
  );

  server.registerTool(
    'get_database',
    {
      description: `Get database details AND live cluster health. The password is never included: connection strings come back with it masked as ****. Call \`get_database_connection\` when you actually need credentials.

Returns host, port, user and database name plus a \`liveStatus\` object with real-time health from Kubernetes:
- \`ready\`: whether enough instances report ready
- \`phase\`: CNPG cluster phase
- \`replicas\` / \`readyReplicas\`: instance counts
- \`restartCount\`: total postgres container restarts across pods (HIGH NUMBERS = INSTABILITY)
- \`message\`: current problem reason if any (e.g. "OOMKilled", "CrashLoopBackOff")
- \`lastTerminationReason\`: last termination reason of the postgres container (e.g. "OOMKilled", "Error"). Present even when the container is currently running. This is how you detect intermittent crashes.
- \`lastTerminationExitCode\`: exit code from the last termination (137 = OOMKill, 139 = segfault, etc.)
- \`lastTerminationAt\`: timestamp of last termination
- \`size\`, \`connections\`: only present when reachable

To diagnose an unhealthy database, check \`liveStatus.message\`, \`liveStatus.lastTerminationReason\`, and \`liveStatus.restartCount\` together. \`status: "ready"\` at the top level reflects only the provisioning state. It can say "ready" while the pod is actively OOM-cycling.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const database = await client.get(path`/databases/${databaseId}`);
      return json(database);
    }
  );

  server.registerTool(
    'get_deployment_logs',
    {
      description: `Read an app's recent runtime logs as plain text lines, newest first, across every replica (the last 24 hours from the log store when there is one, otherwise a live read of the running pods). Start with diagnose_deployment; for a time window, more filters or paging use search_logs, which this calls with simpler inputs.

\`level\` keeps only that level and \`search\` keeps lines containing every word. Output is capped near 40 KB; pass the returned \`cursor\` to search_logs for older lines.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        tailLines: z
          .number()
          .optional()
          .describe('How many lines to return per pod before filtering (default 200, max 20000)'),
        level: z
          .enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'])
          .optional()
          .describe('Return only lines parsed at exactly this level'),
        search: z.string().optional().describe('Only return lines containing this substring')
      }
    },
    async ({ deploymentId, tailLines, level, search }) => {
      const normalized = level
        ? level.toLowerCase().replace('fatal', 'error').replace('trace', 'debug')
        : undefined;
      const end = Date.now();
      const result = await client.get(
        path`/observe/deployments/${deploymentId}/logs/search` +
          toQuery({
            q: search,
            levels: normalized,
            start: end - 24 * 60 * 60 * 1000,
            end,
            limit: Math.min(Math.max(tailLines ?? 200, 1), 500)
          })
      );
      const capped = capLines(result?.entries ?? [], result?.cursor ?? null);
      return json({ source: result?.source ?? null, ...capped });
    }
  );

  server.registerTool(
    'get_deployment_http_metrics',
    {
      description: `Request rate, average and max latency, and 5xx rate for a deployment, as served through its ingress. Latency is the load balancer's average and max, not a percentile.

Answers "is it actually serving traffic", "did latency regress after that deploy", "how many 5xx". Defaults to the last hour at 30s resolution. Returns empty series when nothing fronts the deployment. Check \`get_deployment.ingresses\` first if that surprises you.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ deploymentId, start, end, step }) => {
      const metrics = await client.get(
        path`/observe/deployments/${deploymentId}/http-metrics` + toQuery({ start, end, step })
      );
      return json(metrics);
    }
  );

  server.registerTool(
    'get_build_logs',
    {
      description: `BuildKit output from the deployment's most recent build, plus \`buildStatus\` and the \`buildError\` summary if it failed.

Returns the **last** \`tailLines\` lines by default, because a build that failed failed at the end and the transcript of a large repo runs to hundreds of KB. Read \`buildError\` first. It is usually the whole answer. Raise \`tailLines\`, or pass \`full: true\`, only when you actually need earlier stages.

For the running app's output use \`get_deployment_logs\`.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        tailLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Lines to return from the end of the log (default 400)'),
        full: z
          .boolean()
          .optional()
          .describe('Return the entire log. Can be very large. Prefer raising tailLines.')
      }
    },
    async ({ deploymentId, tailLines, full }) => {
      const res = await client.get(path`/deployments/${deploymentId}/logs`);
      // The API hands back the whole unbounded build_logs column. Trimming to
      // the tail here is what keeps a failed monorepo build from evicting the
      // rest of the caller's context; the failure is at the end anyway.
      const raw = typeof res === 'string' ? res : (res?.logs ?? '');
      const lines = raw ? raw.split('\n') : [];
      const limit = tailLines ?? 400;
      const truncated = !full && lines.length > limit;
      const body = truncated ? lines.slice(-limit).join('\n') : raw;

      return json({
        buildStatus: typeof res === 'string' ? undefined : res?.status,
        buildError: typeof res === 'string' ? undefined : res?.buildError,
        totalLines: lines.length,
        ...(truncated
          ? { showing: `last ${limit} of ${lines.length} lines`, truncated: true }
          : {}),
        logs: body
      });
    }
  );

  server.registerTool(
    'list_pods',
    {
      description:
        'List all running pods for a deployment. The response includes the namespace which you should pass to get_pod_logs.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        ...pageInput
      }
    },
    async ({ deploymentId, limit, cursor }) => {
      const [pods, deployment] = await Promise.all([
        client.get(path`/deployments/${deploymentId}/pods`),
        client.get(path`/deployments/${deploymentId}`)
      ]);
      const page = paginate(Array.isArray(pods) ? pods : (pods?.pods ?? pods?.items), {
        limit,
        cursor
      });
      return json({ namespace: deployment?.namespace, ...page });
    }
  );

  server.registerTool(
    'get_pod_logs',
    {
      description:
        'Get runtime logs from a specific pod. Use list_pods first to get pod names. Pass previous=true to read the logs of the prior (terminated) container instance after a crash/OOM restart.',
      inputSchema: {
        podName: z.string().describe('The pod name (from list_pods)'),
        namespace: z
          .string()
          .describe('Kubernetes namespace. Get this from the deployment details or list_pods.'),
        tailLines: z.number().optional().describe('Number of log lines to return (default: 100)'),
        previous: z
          .boolean()
          .optional()
          .describe(
            'Read logs from the previous (terminated) container instance instead of the current one. Use this to see what a crashed/OOMKilled container printed before it died.'
          )
      }
    },
    async ({ podName, namespace, tailLines, previous }) => {
      const logs = await client.get(
        path`/pods/${podName}/logs` +
          toQuery({ namespace, tailLines, previous: previous ? 'true' : undefined })
      );
      return typeof logs === 'string' ? text(logs) : json(logs);
    }
  );

  server.registerTool(
    'list_killed_containers',
    {
      description:
        'List recently killed containers for a deployment (last 24h): pod, container, termination reason (e.g. OOMKilled), exit code, and when it died. Their pre-death logs are captured even if the pod no longer exists. Pass an entryId to get_killed_container_logs to read them. Use this first when diagnosing crashes, OOMs, or restart loops.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        ...pageInput
      }
    },
    async ({ deploymentId, limit, cursor }) => {
      const entries = await client.get(path`/deployments/${deploymentId}/killed-containers`);
      return json(Array.isArray(entries) ? paginate(entries, { limit, cursor }) : entries);
    }
  );

  server.registerTool(
    'get_killed_container_logs',
    {
      description:
        'Get the captured logs a killed container printed before it died (last ~500 lines, retained 24h). Works even after the pod was deleted. Use list_killed_containers first to get the entryId.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        entryId: z.string().describe('The killed-container entryId (from list_killed_containers)')
      }
    },
    async ({ deploymentId, entryId }) => {
      const entry = await client.get(
        path`/deployments/${deploymentId}/killed-containers/${entryId}/logs`
      );
      return json(entry);
    }
  );

  server.registerTool(
    'list_deployment_errors',
    {
      description:
        'List grouped application errors for a deployment, parsed from its logs and persisted across redeploys. Each group carries a stable fingerprint, occurrence count, triage status (unresolved/resolved/ignored), assignee, and deploy provenance: the commit it was first seen after, that commit message, the branch, and who deployed it. Use this to find what is broken, whether it is already triaged, and which release introduced it.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        window: z.number().optional().describe('Look-back window in minutes (default 60, max 1440)')
      }
    },
    async ({ deploymentId, window }) => {
      const groups = await client.get(
        path`/observe/deployments/${deploymentId}/errors` + toQuery({ window })
      );
      return json(groups);
    }
  );

  server.registerTool(
    'triage_deployment_error',
    {
      description:
        'Set the triage status of an error group, or assign it to a user. Status must be unresolved, resolved, or ignored. Resolving records who resolved it; if the error fires again after being resolved it automatically reopens. Get the fingerprint from list_deployment_errors.',
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        fingerprint: z
          .string()
          .describe('The error group fingerprint (from list_deployment_errors)'),
        status: z
          .enum(['unresolved', 'resolved', 'ignored'])
          .optional()
          .describe('New triage status'),
        assigneeId: z
          .guid()
          .nullable()
          .optional()
          .describe('User UUID to assign, or null to unassign')
      }
    },
    async ({ deploymentId, fingerprint, status, assigneeId }) => {
      const body: Record<string, unknown> = {};
      if (status) body.status = status;
      if (assigneeId !== undefined) body.assigneeId = assigneeId;
      const res = await client.patch(
        path`/observe/deployments/${deploymentId}/errors/${fingerprint}`,
        body
      );
      return json(res);
    }
  );

  server.registerTool(
    'get_pod_details',
    {
      description:
        'Get detailed information about a specific pod including status, IP, node, and restart count',
      inputSchema: {
        podName: z.string().describe('The pod name (from list_pods)'),
        namespace: z
          .string()
          .describe('Kubernetes namespace. Get this from the deployment details or list_pods.')
      }
    },
    async ({ podName, namespace }) => {
      const pod = await client.get(path`/pods/${podName}` + toQuery({ namespace }));
      return json(pod);
    }
  );

  server.registerTool(
    'exec_in_pod',
    {
      description: `Run a one-shot command inside a running pod's container and return stdout/stderr. Equivalent to \`kubectl exec\`.
Use this to:
- Inspect files on disk (e.g. \`ls /data\`, \`cat /app/config.json\`)
- Run health checks or quick diagnostics (e.g. \`curl -sv localhost:3000/health\`)
- Check installed binaries or env (\`env\`, \`which node\`, \`node -v\`)
- Tail a single file (\`tail -n 50 /var/log/app.log\`)

The \`command\` arg can be a string (executed via /bin/sh -c) or a string array (exec'd directly with no shell, preferred when arguments contain special chars).
Pass \`deploymentId\` and the newest ready pod of that deployment is picked for you, which survives pod names changing on every restart. Pass \`podName\` and \`namespace\` (from \`list_pods\`) to target one pod exactly. If \`container\` is omitted, the first container in the pod spec is used.
Not for long-running interactive sessions. The call times out (default 60s, max 5min). stdout and stderr are capped at the last 20,000 characters each.

Needs an exec-scoped session: connect with the mcp:exec scope or an orch_ token with exec scope.`,
      inputSchema: {
        deploymentId: z
          .guid()
          .optional()
          .describe(
            'Run in the newest ready pod of this deployment. Use instead of podName/namespace.'
          ),
        podName: z
          .string()
          .optional()
          .describe('Exact pod name (from list_pods). Omit to pick one from deploymentId.'),
        namespace: z
          .string()
          .optional()
          .describe(
            'Kubernetes namespace (from list_pods). Taken from the deployment when deploymentId is given.'
          ),
        command: z
          .union([z.string(), z.array(z.string()).max(4096)])
          .describe(
            'Command to run. String → run via /bin/sh -c. Array → exec directly (e.g. ["ls", "-la", "/data"]).'
          ),
        container: z
          .string()
          .optional()
          .describe('Container name within the pod (defaults to the first container)'),
        timeoutMs: z
          .number()
          .optional()
          .describe('Hard timeout in milliseconds (default 60000, max 300000)')
      }
    },
    async ({ deploymentId, podName, namespace, command, container, timeoutMs }) => {
      let target = podName;
      let targetNamespace = namespace;
      if (deploymentId && (!target || !targetNamespace)) {
        const [pods, deployment] = await Promise.all([
          client.get(path`/deployments/${deploymentId}/pods`),
          client.get(path`/deployments/${deploymentId}`)
        ]);
        targetNamespace ??= deployment?.namespace;
        target ??= pickExecPod(Array.isArray(pods) ? pods : (pods?.pods ?? pods?.items ?? []));
        if (!target) return failure(`Deployment ${deploymentId} has no running pod to exec into`);
      }
      if (!target || !targetNamespace) {
        return failure('Pass deploymentId, or both podName and namespace');
      }
      const result = await client.post(path`/pods/${target}/exec`, {
        namespace: targetNamespace,
        command,
        ...(container && { container }),
        ...(timeoutMs && { timeoutMs })
      });
      if (typeof result === 'string') return text(capText(result).text);
      const capped: Record<string, unknown> = { pod: target, ...(result ?? {}) };
      for (const key of ['stdout', 'stderr', 'output']) {
        const value = capped[key];
        if (typeof value !== 'string') continue;
        const { text: trimmed, truncated } = capText(value);
        capped[key] = trimmed;
        if (truncated) capped[`${key}Truncated`] = true;
      }
      return json(capped);
    }
  );

  server.registerTool(
    'get_deployment_metrics',
    {
      description: `Fetch a time-series of CPU and memory usage for a deployment from the metrics backend.
Useful for diagnosing performance issues, sizing resource requests, and answering "is this near its limits?".

The result includes datapoints sampled at \`step\` ms intervals between \`start\` and \`end\` (both unix-ms). Defaults to the last hour at 30s resolution.

Each series datapoint includes pod-level CPU (millicores) and memory (bytes). To get aggregate "is it near its limit" pressure, compare \`get_deployment.totalCpuUsage / (cpuRequestMilli × replicas)\` and the memory equivalent.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ deploymentId, start, end, step }) => {
      const metrics = await client.get(
        path`/deployments/${deploymentId}/metrics` + toQuery({ start, end, step })
      );
      return json(metrics);
    }
  );

  server.registerTool(
    'get_database_metrics',
    {
      description: `Fetch a time-series of CPU and memory usage for a database pod from the metrics backend.
Useful for confirming OOM/restart suspicions (memory climbing to the limit before a kill), sizing memory/CPU requests, and answering "is this near its limit?".

The result includes datapoints sampled at \`step\` ms intervals between \`start\` and \`end\` (both unix-ms). Defaults to the last hour at 30s resolution.

To diagnose an OOMKill, look for memory rising to the request/limit ceiling right before \`liveStatus.lastTerminationAt\` (from get_database). If memory plateaus near the limit, raise it with update_database_resources.`,
      inputSchema: {
        databaseId: z.guid().describe('The database UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ databaseId, start, end, step }) => {
      const metrics = await client.get(
        path`/databases/${databaseId}/metrics` + toQuery({ start, end, step })
      );
      return json(metrics);
    }
  );

  server.registerTool(
    'analyze_deployment_resources',
    {
      description: `Snapshot the deployment's current resource pressure. Combines live aggregate CPU/memory usage with the configured per-pod requests and replica count to compute a usage ratio for each axis.
Returns a per-deployment summary: cpu/memory current usage, request × replicas capacity, ratio, and a "near limit" flag (≥85%).
Use this before suggesting scale-ups, or to confirm an unhealthy / OOM-looking deployment is actually starved.`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const dep = await client.get(path`/deployments/${deploymentId}`);
      const replicas = Number(dep.replicas ?? 1);
      const cpuReq = dep.cpuRequestMilli != null ? Number(dep.cpuRequestMilli) : null;
      const memReq = dep.memoryRequestBytes != null ? Number(dep.memoryRequestBytes) : null;
      const cpuUsage = dep.totalCpuUsage != null ? Number(dep.totalCpuUsage) : null;
      const memUsage = dep.totalMemoryUsage != null ? Number(dep.totalMemoryUsage) : null;

      const cpuCapacity = cpuReq != null && cpuReq > 0 ? cpuReq * replicas : null;
      const memCapacity = memReq != null && memReq > 0 ? memReq * replicas : null;
      const cpuRatio = cpuCapacity != null && cpuUsage != null ? cpuUsage / cpuCapacity : null;
      const memRatio = memCapacity != null && memUsage != null ? memUsage / memCapacity : null;
      const NEAR = 0.85;

      const summary = {
        deploymentId,
        name: dep.name,
        replicas,
        cpu: {
          usageMilli: cpuUsage,
          requestPerPodMilli: cpuReq,
          capacityMilli: cpuCapacity,
          ratio: cpuRatio,
          nearLimit: cpuRatio != null && cpuRatio >= NEAR,
          unlimited: cpuReq === 0
        },
        memory: {
          usageBytes: memUsage,
          requestPerPodBytes: memReq,
          capacityBytes: memCapacity,
          ratio: memRatio,
          nearLimit: memRatio != null && memRatio >= NEAR,
          unlimited: memReq === 0
        },
        recommendation:
          (cpuRatio != null && cpuRatio >= NEAR) || (memRatio != null && memRatio >= NEAR)
            ? 'Usage is near limits. Consider increasing CPU/memory requests, the pod may behave unexpectedly under load.'
            : 'Within healthy bounds.'
      };
      return json(summary);
    }
  );

  server.registerTool(
    'get_deployment_volumes',
    {
      description: `Get all volumes attached to a deployment, plus the deploy strategy that volumes drive.
Volumes are returned with their full record (id, name, type, mountPath, pvcName, storageSize, hostPath, readOnly).
The response also surfaces \`deployStrategy\` and a \`pvcCount\` so callers can sanity-check that PVCs they expected are actually attached. A 0 PVC count on what should be a stateful deployment usually means the last volumes update silently dropped a row (e.g. type=pvc without pvcName).`,
      inputSchema: {
        deploymentId: z.guid().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(path`/deployments/${deploymentId}`);
      const volumes: any[] = Array.isArray(deployment?.volumes) ? deployment.volumes : [];
      const pvcCount = volumes.filter((v: any) => v?.type === 'pvc').length;
      const payload = {
        deploymentId,
        deploymentName: deployment?.name,
        namespace: deployment?.namespace,
        deployStrategy: deployment?.deployStrategy ?? null,
        rollingDeploysDisabled: pvcCount > 0,
        pvcCount,
        volumeCount: volumes.length,
        volumes,
        note:
          pvcCount > 0
            ? `This deployment has ${pvcCount} PVC volume(s); k8s update strategy is forced to Recreate so rolling deploys are disabled.`
            : undefined
      };
      return json(payload);
    }
  );

  server.registerTool(
    'get_github_status',
    {
      description:
        "Check if the user's GitHub account is linked to Orchard. Required before deploying from GitHub repos.",
      inputSchema: {}
    },
    async () => {
      const status = await client.get('/github/status');
      return json(status);
    }
  );

  server.registerTool(
    'list_github_repos',
    {
      description: `Autocomplete source for deploy_from_github. Lists repos that are BOTH (a) covered by an Orchard GitHub App installation the user has access to AND (b) accessible to the user's own GitHub account, which is the intersection. These are safe to suggest because the deploy will succeed for them. The user should never be shown repos they cannot access on GitHub.`,
      inputSchema: { ...pageInput }
    },
    async ({ limit, cursor }) => {
      const repos = await client.get('/github/repositories');
      return json(Array.isArray(repos) ? paginate(repos, { limit, cursor }) : repos);
    }
  );

  server.registerTool(
    'get_repo_branches',
    {
      description: 'Get branches for a GitHub repository',
      inputSchema: {
        owner: z.string().describe('Repository owner (GitHub username or org)'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const branches = await client.get(path`/github/repositories/${owner}/${repo}/branches`);
      return json(branches);
    }
  );

  server.registerTool(
    'get_repo_dockerfiles',
    {
      description:
        'Find Dockerfiles in a GitHub repository. Useful to determine if a repo can be deployed and which Dockerfile to use.',
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const dockerfiles = await client.get(path`/github/repositories/${owner}/${repo}/dockerfiles`);
      return json(dockerfiles);
    }
  );

  server.registerTool(
    'detect_repo_config',
    {
      description: `Work out how a GitHub repository should be built, before deploying it.

Returns the build type Orchard would pick, plus, for repos with no Dockerfile, an "apps" array describing every deployable app found: its directory, framework, install/build/start commands and output directory. An app with an outputDirectory is a static site. "workspace" reports whether the repo is a pnpm/npm/yarn workspace.

Use this to answer "can I deploy this repo" and "which app in this monorepo did the user mean" before calling deploy_from_github. Everything it returns is a suggestion the deploy call can override.`,
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
        branch: z
          .string()
          .optional()
          .describe('Branch to inspect (default: the repository default branch)')
      }
    },
    async ({ owner, repo, branch }) => {
      const detected = await client.get(
        path`/github/repositories/${owner}/${repo}/detect` + toQuery({ branch })
      );
      return json(detected);
    }
  );

  server.registerTool(
    'get_repo_contents',
    {
      description:
        'Get the file/directory listing of a GitHub repository. Useful to analyze what the app needs.',
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const contents = await client.get(path`/github/repositories/${owner}/${repo}/contents`);
      return json(contents);
    }
  );

  server.registerTool(
    'list_templates',
    {
      description: 'List all available templates (both built-in and custom)',
      inputSchema: { ...pageInput }
    },
    async ({ limit, cursor }) => {
      const templates = await client.get('/templates');
      return json(Array.isArray(templates) ? paginate(templates, { limit, cursor }) : templates);
    }
  );

  server.registerTool(
    'get_template',
    {
      description: 'Get a template by ID, including its full YAML definition and parameter schema',
      inputSchema: {
        templateId: z.guid().describe('The template UUID')
      }
    },
    async ({ templateId }) => {
      const template = await client.get(path`/templates/${templateId}`);
      return json(template);
    }
  );

  server.registerTool(
    'list_template_instances',
    {
      description: 'List all template instances (deployed templates) in a project',
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        ...pageInput
      }
    },
    async ({ projectId, limit, cursor }) => {
      const instances = await client.get(path`/projects/${projectId}/template-instances`);
      return json(Array.isArray(instances) ? paginate(instances, { limit, cursor }) : instances);
    }
  );

  server.registerTool(
    'get_template_instance',
    {
      description: 'Get details of a deployed template instance, including all created resources',
      inputSchema: {
        instanceId: z.guid().describe('The template instance UUID')
      }
    },
    async ({ instanceId }) => {
      const instance = await client.get(path`/template-instances/${instanceId}`);
      return json(instance);
    }
  );

  server.registerTool(
    'get_template_yaml_guide',
    {
      description:
        'Get the full YAML format guide for creating Leaf templates, including all resource types, parameter types, interpolation syntax, and a complete example. Also published as the orchard://docs/template-yaml-guide resource.',
      inputSchema: {}
    },
    async () => ({ content: [{ type: 'text', text: YAML_FORMAT_GUIDE }] })
  );
}

interface ExecCandidate {
  name: string;
  status?: string;
  phase?: string;
  deletingAt?: string | null;
  createdAt?: string;
}

export function pickExecPod(pods: ExecCandidate[]): string | undefined {
  const live = pods.filter((pod) => !pod.deletingAt);
  const newest = (list: ExecCandidate[]) =>
    [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]?.name;
  return (
    newest(live.filter((pod) => pod.status === 'ready')) ??
    newest(live.filter((pod) => pod.phase === 'Running'))
  );
}
