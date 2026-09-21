import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';
import { json, text } from './reply';

const YAML_FORMAT_GUIDE = `
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

**database** — Creates a PostgreSQL database.
Available context fields: id, host, port, dbName, dbUser, dbPassword, connectionString
\`\`\`yaml
- name: db
  type: database
  config:
    name: "{{ params.appName }}-db"
\`\`\`

**deployment** — Creates a container deployment.
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
    exposePublic: true                # optional, creates external service
\`\`\`

**ingress** — Creates a public domain route.
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

- \`{{ params.paramName }}\` — inserts a parameter value
- \`{{ resources.resourceName.field }}\` — references a previously created resource
- Resources are created in order, so a deployment can reference a database created before it

### Example: Full-stack Node.js + PostgreSQL

\`\`\`yaml
apiVersion: leaf/v1
kind: Template
metadata:
  name: nodejs-postgres
  displayName: Node.js + PostgreSQL
  description: A Node.js app with a PostgreSQL database and public ingress.
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
  // ── User & Organizations ──────────────────────────────────────────

  server.registerTool(
    'get_current_user',
    {
      description: "Get the currently authenticated user's profile information",
      annotations: { readOnlyHint: true, destructiveHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => {
      const orgs = await client.get('/organizations/user');
      return json(orgs);
    }
  );

  // ── Resolution ────────────────────────────────────────────────────

  server.registerTool(
    'find',
    {
      description: `Turn a name into a UUID. **Start here** whenever the user names something ("restart hackatime", "the leaf db") instead of walking list_organizations → list_projects → list_deployments.

Searches organizations, projects, deployments and databases at once and returns compact matches with the ids every other tool wants. Matching is case-insensitive substring over names, slugs, GitHub repos and ingress hosts. Call it with no query to get an inventory of everything the user can see.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Substring to match. Omit to return everything the user can see.'),
        kinds: z
          .array(z.enum(['organization', 'project', 'deployment', 'database']))
          .optional()
          .describe('Restrict the search to these kinds. Default: all four.'),
        organizationId: z.string().optional().describe('Restrict the search to one organization')
      }
    },
    async ({ query, kinds, organizationId }) => {
      const wanted = new Set(kinds ?? ['organization', 'project', 'deployment', 'database']);
      const orgQs = organizationId ? `?orgId=${encodeURIComponent(organizationId)}` : '';
      const needle = (query ?? '').trim().toLowerCase();
      const hit = (...fields: unknown[]) =>
        !needle || fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));

      const [orgs, projects, deployments, databases] = await Promise.all([
        wanted.has('organization') ? client.get('/organizations/user').catch(() => []) : [],
        wanted.has('project') ? client.get(`/projects${orgQs}`).catch(() => []) : [],
        wanted.has('deployment') ? client.get(`/deployments${orgQs}`).catch(() => []) : [],
        wanted.has('database') ? client.get(`/databases${orgQs}`).catch(() => []) : []
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

      return json({ query: query ?? null, results });
    }
  );

  server.registerTool(
    'get_resource_quota',
    {
      description: `How much CPU and memory the caller can still hand out in an organization.

**Check this before sizing anything.** \`create_deployment\`, \`update_deployment_resources\`, \`scale_deployment\`, \`scale_database\` and \`start_deployment\` are all quota-checked server-side and simply fail when the numbers do not fit; this is the only way to know the ceiling in advance instead of guessing and retrying.

\`effectiveLimit\` is the number you want: the most that can go on a single deployment right now, already reduced to \`min(what this member has left, what the org has left)\`. A null means unlimited on that axis. \`allowance\` / \`usage\` / \`orgCap\` show the working.

Units match the resource tools: \`cpuMilli\` in millicores, \`memoryBytes\` in bytes.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        organizationId: z
          .string()
          .describe('The organization UUID (from list_organizations, or find)')
      }
    },
    async ({ organizationId }) => {
      const quota = await client.get(`/organizations/${organizationId}/quota/me`);
      return json(quota);
    }
  );

  server.registerTool(
    'get_audit_log',
    {
      description: `Who changed what, and when. Pass a deploymentId for one app's history, or an organizationId for everything in the org (org admins only).

This is how you answer "when did this break" and "who turned that off" — each entry records the actor, a timestamp, the action (\`deployment.env.updated\`, \`deployment.scaled\`, \`deployment.stopped\`, \`environment.sharedvars.updated\`, …) and a \`metadata\` object that usually carries the \`[before, after]\` of whatever moved. Paginated: feed \`nextCursor\` back as \`cursor\` for the next page.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
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
      const scope = deploymentId ? `deployment/${deploymentId}` : `organization/${organizationId}`;
      const params = new URLSearchParams();
      if (action) params.set('action', action);
      if (limit) params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const logs = await client.get(`/audit-logs/${scope}${qs ? `?${qs}` : ''}`);
      return json(logs);
    }
  );

  server.registerTool(
    'list_node_pools',
    {
      description: `List the node pools a deployment can be pinned to, for \`update_deployment_placement\` or \`create_deployment\`'s \`nodePoolId\`.

Only pools an administrator marked user-selectable show up. On an instance that has not enabled userspace scheduling the call 404s, which just means placement is not a knob here — schedule anywhere and move on.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => {
      const pools = await client.get('/node-pools');
      return json(pools);
    }
  );

  // ── Projects ──────────────────────────────────────────────────────

  server.registerTool(
    'list_projects',
    {
      description:
        'List projects. With no arguments this returns every project the user can see across all their organizations, so you do not need to walk `list_organizations` first. Pass an organizationId only to narrow it.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().optional().describe('Organization UUID to filter by (optional)')
      }
    },
    async ({ organizationId }) => {
      const url = organizationId ? `/projects?orgId=${organizationId}` : '/projects';
      const projects = await client.get(url);
      return json(projects);
    }
  );

  server.registerTool(
    'get_project',
    {
      description: 'Get project details including deployments, databases, and ingresses',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID')
      }
    },
    async ({ projectId }) => {
      const project = await client.get(`/projects/${projectId}`);
      return json(project);
    }
  );

  // ── Deployments ───────────────────────────────────────────────────

  server.registerTool(
    'list_deployments',
    {
      description: `List deployments. Pass a projectId for one project's deployments, or nothing at all to get every deployment the user can see (optionally narrowed to one organization).

Use \`find\` instead when you know the app by name and want its UUID.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('The project UUID. Omit to list across every project the user can see.'),
        organizationId: z
          .string()
          .optional()
          .describe('Narrow the cross-project listing to one organization. Ignored with projectId.')
      }
    },
    async ({ projectId, organizationId }) => {
      const path = projectId
        ? `/projects/${projectId}/deployments`
        : `/deployments${organizationId ? `?orgId=${encodeURIComponent(organizationId)}` : ''}`;
      const deployments = await client.get(path);
      return json(deployments);
    }
  );

  server.registerTool(
    'get_deployment',
    {
      description: `Get deployment details: status, image, replicas, env vars, services, ingresses, volumes, health check, build config, placement and recent image history.

The build log is omitted here because it is often megabytes — read it with \`get_build_logs\`. Runtime logs are \`get_deployment_logs\`.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      // buildLogs is the raw BuildKit transcript and routinely dwarfs everything
      // else on the record. Shipping it on every read burns the caller's context
      // for something they did not ask for; get_build_logs exists for that.
      const { buildLogs, ...rest } = deployment ?? {};
      const slim = {
        ...rest,
        ...(buildLogs ? { buildLogs: '<omitted — call get_build_logs>' } : {})
      };
      return json(slim);
    }
  );

  server.registerTool(
    'get_image_history',
    {
      description: 'Get the image version history for a deployment (for rollback purposes)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const history = await client.get(`/deployments/${deploymentId}/image-history`);
      return json(history);
    }
  );

  // ── Environment Variables ─────────────────────────────────────────

  server.registerTool(
    'get_env_vars',
    {
      description: `Get the current environment variables for a deployment.

Secret vars come back with \`secret: true\` and a null value — the value is write-only and never readable. To change one, use \`add_env_vars\`; you do not need to read it first.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const envVars = deployment.envVars || [];
      return json(envVars);
    }
  );

  // ── Networking ────────────────────────────────────────────────────

  server.registerTool(
    'list_ingresses',
    {
      description: 'List all ingresses (public domains/routes) for a deployment',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const ingresses = deployment.ingresses || [];
      return json(ingresses);
    }
  );

  server.registerTool(
    'get_ingress',
    {
      description: 'Get ingress details',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        ingressId: z.string().describe('The ingress UUID')
      }
    },
    async ({ ingressId }) => {
      const ingress = await client.get(`/ingresses/${ingressId}`);
      return json(ingress);
    }
  );

  server.registerTool(
    'validate_dns',
    {
      description:
        "Validate that a domain's DNS is correctly pointed to the Orchard cluster. Run this before creating an ingress.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z
          .string()
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const services = deployment.services || [];
      return json(services);
    }
  );

  // ── Databases ─────────────────────────────────────────────────────

  server.registerTool(
    'list_databases',
    {
      description:
        "List PostgreSQL databases. Pass a projectId for one project's databases, or nothing at all to get every database the user can see (optionally narrowed to one organization).",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe('The project UUID. Omit to list across every project the user can see.'),
        organizationId: z
          .string()
          .optional()
          .describe('Narrow the cross-project listing to one organization. Ignored with projectId.')
      }
    },
    async ({ projectId, organizationId }) => {
      const path = projectId
        ? `/projects/${projectId}/databases`
        : `/databases${organizationId ? `?orgId=${encodeURIComponent(organizationId)}` : ''}`;
      const databases = await client.get(path);
      return json(databases);
    }
  );

  server.registerTool(
    'get_database',
    {
      description: `Get database details including connection information AND live cluster health.

Returns connection info (host, port, user, password, database name) plus a \`liveStatus\` object with real-time health from Kubernetes:
- \`ready\`: whether enough instances report ready
- \`phase\`: CNPG cluster phase
- \`replicas\` / \`readyReplicas\`: instance counts
- \`restartCount\`: total postgres container restarts across pods (HIGH NUMBERS = INSTABILITY)
- \`message\`: current problem reason if any (e.g. "OOMKilled", "CrashLoopBackOff")
- \`lastTerminationReason\`: last termination reason of the postgres container (e.g. "OOMKilled", "Error"). Present even when the container is currently running — this is how you detect intermittent crashes.
- \`lastTerminationExitCode\`: exit code from the last termination (137 = OOMKill, 139 = segfault, etc.)
- \`lastTerminationAt\`: timestamp of last termination
- \`size\`, \`connections\`: only present when reachable

To diagnose an unhealthy database, check \`liveStatus.message\`, \`liveStatus.lastTerminationReason\`, and \`liveStatus.restartCount\` together. \`status: "ready"\` at the top level reflects only the provisioning state — it can say "ready" while the pod is actively OOM-cycling.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID')
      }
    },
    async ({ databaseId }) => {
      const database = await client.get(`/databases/${databaseId}`);
      return json(database);
    }
  );

  // ── Logs & Pods ───────────────────────────────────────────────────

  server.registerTool(
    'get_deployment_logs',
    {
      description: `Read an app's runtime logs. **This is the tool you want for "why is my app broken"** — it takes a deploymentId, merges every replica, and parses each line into a level, timestamp and message.

\`get_pod_logs\` is the lower-level escape hatch for when you need one specific pod (or its previous, crashed container). This one saves you the \`list_pods\` round trip and works across a rolling deploy.

Filter with \`level\` to see only errors, or \`search\` to grep. Both are applied server-side, so narrowing costs you nothing. Levels are inferred from the line, so a line the parser could not classify has no level and is dropped by any \`level\` filter — drop the filter if a search comes back emptier than you expect.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
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
      const params = new URLSearchParams();
      if (tailLines) params.set('tailLines', String(tailLines));
      if (level) params.set('level', level);
      if (search) params.set('search', search);
      const qs = params.toString();
      const logs = await client.get(
        `/observe/deployments/${deploymentId}/logs/structured${qs ? `?${qs}` : ''}`
      );
      return json(logs);
    }
  );

  server.registerTool(
    'get_deployment_http_metrics',
    {
      description: `Request rate, latency percentiles and status-code breakdown for a deployment, as served through its ingress.

Answers "is it actually serving traffic", "did latency regress after that deploy", "how many 5xx". Defaults to the last hour at 30s resolution. Returns empty series when nothing fronts the deployment — check \`get_deployment.ingresses\` first if that surprises you.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ deploymentId, start, end, step }) => {
      const params = new URLSearchParams();
      if (start) params.set('start', String(start));
      if (end) params.set('end', String(end));
      if (step) params.set('step', String(step));
      const qs = params.toString();
      const metrics = await client.get(
        `/observe/deployments/${deploymentId}/http-metrics${qs ? `?${qs}` : ''}`
      );
      return json(metrics);
    }
  );

  server.registerTool(
    'get_build_logs',
    {
      description: `BuildKit output from the deployment's most recent build, plus \`buildStatus\` and the \`buildError\` summary if it failed.

Returns the **last** \`tailLines\` lines by default, because a build that failed failed at the end and the transcript of a large repo runs to hundreds of KB. Read \`buildError\` first — it is usually the whole answer. Raise \`tailLines\`, or pass \`full: true\`, only when you actually need earlier stages.

For the running app's output use \`get_deployment_logs\`.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        tailLines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Lines to return from the end of the log (default 400)'),
        full: z
          .boolean()
          .optional()
          .describe('Return the entire log. Can be very large — prefer raising tailLines.')
      }
    },
    async ({ deploymentId, tailLines, full }) => {
      const res = await client.get(`/deployments/${deploymentId}/logs`);
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const [pods, deployment] = await Promise.all([
        client.get(`/deployments/${deploymentId}/pods`),
        client.get(`/deployments/${deploymentId}`)
      ]);
      const result = {
        namespace: deployment?.namespace,
        pods
      };
      return json(result);
    }
  );

  server.registerTool(
    'get_pod_logs',
    {
      description:
        'Get runtime logs from a specific pod. Use list_pods first to get pod names. Pass previous=true to read the logs of the prior (terminated) container instance after a crash/OOM restart.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        podName: z.string().describe('The pod name (from list_pods)'),
        namespace: z
          .string()
          .optional()
          .describe(
            'Kubernetes namespace (defaults to deployment namespace). Get this from the deployment details or list_pods.'
          ),
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
      const params = new URLSearchParams();
      if (namespace) params.set('namespace', namespace);
      if (tailLines) params.set('tailLines', String(tailLines));
      if (previous) params.set('previous', 'true');
      const qs = params.toString();
      const logs = await client.get(`/pods/${podName}/logs${qs ? `?${qs}` : ''}`);
      return typeof logs === 'string' ? text(logs) : json(logs);
    }
  );

  server.registerTool(
    'list_killed_containers',
    {
      description:
        'List recently killed containers for a deployment (last 24h): pod, container, termination reason (e.g. OOMKilled), exit code, and when it died. Their pre-death logs are captured even if the pod no longer exists — pass an entryId to get_killed_container_logs to read them. Use this first when diagnosing crashes, OOMs, or restart loops.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const entries = await client.get(`/deployments/${deploymentId}/killed-containers`);
      return json(entries);
    }
  );

  server.registerTool(
    'get_killed_container_logs',
    {
      description:
        'Get the captured logs a killed container printed before it died (last ~500 lines, retained 24h). Works even after the pod was deleted. Use list_killed_containers first to get the entryId.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        entryId: z.string().describe('The killed-container entryId (from list_killed_containers)')
      }
    },
    async ({ deploymentId, entryId }) => {
      const entry = await client.get(
        `/deployments/${deploymentId}/killed-containers/${encodeURIComponent(entryId)}/logs`
      );
      return json(entry);
    }
  );

  server.registerTool(
    'list_deployment_errors',
    {
      description:
        'List grouped application errors for a deployment, parsed from its logs and persisted across redeploys. Each group carries a stable fingerprint, occurrence count, triage status (unresolved/resolved/ignored), assignee, and deploy provenance: the commit it was first seen after, that commit message, the branch, and who deployed it. Use this to find what is broken, whether it is already triaged, and which release introduced it.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        window: z.number().optional().describe('Look-back window in minutes (default 60, max 1440)')
      }
    },
    async ({ deploymentId, window }) => {
      const qs = window ? `?window=${window}` : '';
      const groups = await client.get(`/observe/deployments/${deploymentId}/errors${qs}`);
      return json(groups);
    }
  );

  server.registerTool(
    'triage_deployment_error',
    {
      description:
        'Set the triage status of an error group, or assign it to a user. Status must be unresolved, resolved, or ignored. Resolving records who resolved it; if the error fires again after being resolved it automatically reopens. Get the fingerprint from list_deployment_errors.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        fingerprint: z
          .string()
          .describe('The error group fingerprint (from list_deployment_errors)'),
        status: z
          .enum(['unresolved', 'resolved', 'ignored'])
          .optional()
          .describe('New triage status'),
        assigneeId: z
          .string()
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
        `/observe/deployments/${deploymentId}/errors/${encodeURIComponent(fingerprint)}`,
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        podName: z.string().describe('The pod name')
      }
    },
    async ({ podName }) => {
      const pod = await client.get(`/pods/${podName}`);
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

The \`command\` arg can be a string (executed via /bin/sh -c) or a string array (exec'd directly with no shell — preferred when arguments contain special chars).
Use \`list_pods\` first to get pod names and the namespace. If \`container\` is omitted, the first container in the pod spec is used.
Not for long-running interactive sessions — the call times out (default 60s, max 5min).`,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        podName: z.string().describe('Pod name (from list_pods)'),
        namespace: z
          .string()
          .describe('Kubernetes namespace (from list_pods or get_deployment.namespace)'),
        command: z
          .union([z.string(), z.array(z.string())])
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
    async ({ podName, namespace, command, container, timeoutMs }) => {
      const result = await client.post(`/pods/${podName}/exec`, {
        namespace,
        command,
        ...(container && { container }),
        ...(timeoutMs && { timeoutMs })
      });
      return json(result);
    }
  );

  server.registerTool(
    'get_deployment_metrics',
    {
      description: `Fetch a time-series of CPU and memory usage for a deployment from the metrics backend.
Useful for diagnosing performance issues, sizing resource requests, and answering "is this near its limits?".

The result includes datapoints sampled at \`step\` ms intervals between \`start\` and \`end\` (both unix-ms). Defaults to the last hour at 30s resolution.

Each series datapoint includes pod-level CPU (millicores) and memory (bytes). To get aggregate "is it near its limit" pressure, compare \`get_deployment.totalCpuUsage / (cpuRequestMilli × replicas)\` and the memory equivalent.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ deploymentId, start, end, step }) => {
      const params = new URLSearchParams();
      if (start) params.set('start', String(start));
      if (end) params.set('end', String(end));
      if (step) params.set('step', String(step));
      const qs = params.toString();
      const metrics = await client.get(`/deployments/${deploymentId}/metrics${qs ? `?${qs}` : ''}`);
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
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
        start: z.number().optional().describe('Window start (unix-ms). Default: end - 1h'),
        end: z.number().optional().describe('Window end (unix-ms). Default: now'),
        step: z.number().optional().describe('Sample step (ms). Default 30000, min 1000')
      }
    },
    async ({ databaseId, start, end, step }) => {
      const params = new URLSearchParams();
      if (start) params.set('start', String(start));
      if (end) params.set('end', String(end));
      if (step) params.set('step', String(step));
      const qs = params.toString();
      const metrics = await client.get(`/databases/${databaseId}/metrics${qs ? `?${qs}` : ''}`);
      return json(metrics);
    }
  );

  server.registerTool(
    'analyze_deployment_resources',
    {
      description: `Snapshot the deployment's current resource pressure. Combines live aggregate CPU/memory usage with the configured per-pod requests and replica count to compute a usage ratio for each axis.
Returns a per-deployment summary: cpu/memory current usage, request × replicas capacity, ratio, and a "near limit" flag (≥85%).
Use this before suggesting scale-ups, or to confirm an unhealthy / OOM-looking deployment is actually starved.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const dep = await client.get(`/deployments/${deploymentId}`);
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
            ? 'Usage is near limits — consider increasing CPU/memory requests, the pod may behave unexpectedly under load.'
            : 'Within healthy bounds.'
      };
      return json(summary);
    }
  );

  // ── Volumes ───────────────────────────────────────────────────────

  server.registerTool(
    'get_deployment_volumes',
    {
      description: `Get all volumes attached to a deployment, plus the deploy strategy that volumes drive.
Volumes are returned with their full record (id, name, type, mountPath, pvcName, storageSize, hostPath, readOnly).
The response also surfaces \`deployStrategy\` and a \`pvcCount\` so callers can sanity-check that PVCs they expected are actually attached — a 0 PVC count on what should be a stateful deployment usually means the last volumes update silently dropped a row (e.g. type=pvc without pvcName).`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID')
      }
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
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

  // ── GitHub ────────────────────────────────────────────────────────

  server.registerTool(
    'get_github_status',
    {
      description:
        "Check if the user's GitHub account is linked to Orchard. Required before deploying from GitHub repos.",
      annotations: { readOnlyHint: true, destructiveHint: false },
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
      description: `Autocomplete source for deploy_from_github. Lists repos that are BOTH (a) covered by an Orchard GitHub App installation the user has access to AND (b) accessible to the user's own GitHub account — i.e. the intersection. These are safe to suggest because the deploy will succeed for them. The user should never be shown repos they cannot access on GitHub.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => {
      const repos = await client.get('/github/repositories');
      return json(repos);
    }
  );

  server.registerTool(
    'get_repo_branches',
    {
      description: 'Get branches for a GitHub repository',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner (GitHub username or org)'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const branches = await client.get(`/github/repositories/${owner}/${repo}/branches`);
      return json(branches);
    }
  );

  server.registerTool(
    'get_repo_dockerfiles',
    {
      description:
        'Find Dockerfiles in a GitHub repository. Useful to determine if a repo can be deployed and which Dockerfile to use.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const dockerfiles = await client.get(`/github/repositories/${owner}/${repo}/dockerfiles`);
      return json(dockerfiles);
    }
  );

  server.registerTool(
    'detect_repo_config',
    {
      description: `Work out how a GitHub repository should be built, before deploying it.

Returns the build type Orchard would pick, plus, for repos with no Dockerfile, an "apps" array describing every deployable app found: its directory, framework, install/build/start commands and output directory. An app with an outputDirectory is a static site. "workspace" reports whether the repo is a pnpm/npm/yarn workspace.

Use this to answer "can I deploy this repo" and "which app in this monorepo did the user mean" before calling deploy_from_github. Everything it returns is a suggestion the deploy call can override.`,
      annotations: { readOnlyHint: true, destructiveHint: false },
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
      const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
      const detected = await client.get(`/github/repositories/${owner}/${repo}/detect${query}`);
      return json(detected);
    }
  );

  server.registerTool(
    'get_repo_contents',
    {
      description:
        'Get the file/directory listing of a GitHub repository. Useful to analyze what the app needs.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name')
      }
    },
    async ({ owner, repo }) => {
      const contents = await client.get(`/github/repositories/${owner}/${repo}/contents`);
      return json(contents);
    }
  );

  // ── Templates ─────────────────────────────────────────────────────

  server.registerTool(
    'list_templates',
    {
      description: 'List all available templates (both built-in and custom)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => {
      const templates = await client.get('/templates');
      return json(templates);
    }
  );

  server.registerTool(
    'get_template',
    {
      description: 'Get a template by ID, including its full YAML definition and parameter schema',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        templateId: z.string().describe('The template UUID')
      }
    },
    async ({ templateId }) => {
      const template = await client.get(`/templates/${templateId}`);
      return json(template);
    }
  );

  server.registerTool(
    'list_template_instances',
    {
      description: 'List all template instances (deployed templates) in a project',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID')
      }
    },
    async ({ projectId }) => {
      const instances = await client.get(`/projects/${projectId}/template-instances`);
      return json(instances);
    }
  );

  server.registerTool(
    'get_template_instance',
    {
      description: 'Get details of a deployed template instance, including all created resources',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        instanceId: z.string().describe('The template instance UUID')
      }
    },
    async ({ instanceId }) => {
      const instance = await client.get(`/template-instances/${instanceId}`);
      return json(instance);
    }
  );

  server.registerTool(
    'get_template_yaml_guide',
    {
      description:
        'Get the full YAML format guide for creating Leaf templates, including all resource types, parameter types, interpolation syntax, and a complete example.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {}
    },
    async () => ({ content: [{ type: 'text', text: YAML_FORMAT_GUIDE }] })
  );
}
