import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerQueryTools(server: McpServer, client: OrchardClient) {
  // ── User & Organizations ──────────────────────────────────────────

  server.registerTool(
    'get_current_user',
    {
      description: "Get the currently authenticated user's profile information",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const user = await client.get('/auth/me');
      return { content: [{ type: 'text', text: JSON.stringify(user, null, 2) }] };
    },
  );

  server.registerTool(
    'list_organizations',
    {
      description: 'List all organizations the authenticated user belongs to',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const orgs = await client.get('/organizations/user');
      return { content: [{ type: 'text', text: JSON.stringify(orgs, null, 2) }] };
    },
  );

  // ── Projects ──────────────────────────────────────────────────────

  server.registerTool(
    'list_projects',
    {
      description: 'List all projects in an organization',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        organizationId: z.string().optional().describe('Organization UUID to filter by (optional)'),
      },
    },
    async ({ organizationId }) => {
      const url = organizationId ? `/projects?orgId=${organizationId}` : '/projects';
      const projects = await client.get(url);
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
    },
  );

  server.registerTool(
    'get_project',
    {
      description: 'Get project details including deployments, databases, and ingresses',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const project = await client.get(`/projects/${projectId}`);
      return { content: [{ type: 'text', text: JSON.stringify(project, null, 2) }] };
    },
  );

  // ── Deployments ───────────────────────────────────────────────────

  server.registerTool(
    'list_deployments',
    {
      description: 'List all deployments in a project',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const deployments = await client.get(`/projects/${projectId}/deployments`);
      return { content: [{ type: 'text', text: JSON.stringify(deployments, null, 2) }] };
    },
  );

  server.registerTool(
    'get_deployment',
    {
      description: 'Get deployment details including status, image, replicas, env vars, services, and ingresses',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      return { content: [{ type: 'text', text: JSON.stringify(deployment, null, 2) }] };
    },
  );

  server.registerTool(
    'get_image_history',
    {
      description: 'Get the image version history for a deployment (for rollback purposes)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const history = await client.get(`/deployments/${deploymentId}/image-history`);
      return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] };
    },
  );

  // ── Environment Variables ─────────────────────────────────────────

  server.registerTool(
    'get_env_vars',
    {
      description: 'Get the current environment variables for a deployment',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const envVars = deployment.envVars || [];
      return { content: [{ type: 'text', text: JSON.stringify(envVars, null, 2) }] };
    },
  );

  // ── Networking ────────────────────────────────────────────────────

  server.registerTool(
    'list_ingresses',
    {
      description: 'List all ingresses (public domains/routes) for a deployment',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const ingresses = deployment.ingresses || [];
      return { content: [{ type: 'text', text: JSON.stringify(ingresses, null, 2) }] };
    },
  );

  server.registerTool(
    'get_ingress',
    {
      description: 'Get ingress details',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        ingressId: z.string().describe('The ingress UUID'),
      },
    },
    async ({ ingressId }) => {
      const ingress = await client.get(`/ingresses/${ingressId}`);
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'validate_dns',
    {
      description: "Validate that a domain's DNS is correctly pointed to the Orchard cluster. Run this before creating an ingress.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        domain: z.string().describe('The domain to validate (e.g. myapp.example.com)'),
      },
    },
    async ({ domain }) => {
      const result = await client.post('/projects/ingresses/validate-dns', { domain });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'list_services',
    {
      description: 'List services for a deployment (internal networking, load balancers, etc.)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const services = deployment.services || [];
      return { content: [{ type: 'text', text: JSON.stringify(services, null, 2) }] };
    },
  );

  // ── Databases ─────────────────────────────────────────────────────

  server.registerTool(
    'list_databases',
    {
      description: 'List all PostgreSQL databases in a project',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const databases = await client.get(`/projects/${projectId}/databases`);
      return { content: [{ type: 'text', text: JSON.stringify(databases, null, 2) }] };
    },
  );

  server.registerTool(
    'get_database',
    {
      description: 'Get database details including connection information (host, port, user, password, database name)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        databaseId: z.string().describe('The database UUID'),
      },
    },
    async ({ databaseId }) => {
      const database = await client.get(`/databases/${databaseId}`);
      return { content: [{ type: 'text', text: JSON.stringify(database, null, 2) }] };
    },
  );

  // ── Logs & Pods ───────────────────────────────────────────────────

  server.registerTool(
    'get_build_logs',
    {
      description: 'Get the build logs for a deployment (Docker build output)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const logs = await client.get(`/deployments/${deploymentId}/logs`);
      return { content: [{ type: 'text', text: typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2) }] };
    },
  );

  server.registerTool(
    'list_pods',
    {
      description: 'List all running pods for a deployment. The response includes the namespace which you should pass to get_pod_logs.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const [pods, deployment] = await Promise.all([
        client.get(`/deployments/${deploymentId}/pods`),
        client.get(`/deployments/${deploymentId}`),
      ]);
      const result = {
        namespace: deployment?.namespace,
        pods,
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_pod_logs',
    {
      description: 'Get runtime logs from a specific pod. Use list_pods first to get pod names.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        podName: z.string().describe('The pod name (from list_pods)'),
        namespace: z.string().optional().describe('Kubernetes namespace (defaults to deployment namespace). Get this from the deployment details or list_pods.'),
        tailLines: z.number().optional().describe('Number of log lines to return (default: 100)'),
      },
    },
    async ({ podName, namespace, tailLines }) => {
      const params = new URLSearchParams();
      if (namespace) params.set('namespace', namespace);
      if (tailLines) params.set('tailLines', String(tailLines));
      const qs = params.toString();
      const logs = await client.get(`/pods/${podName}/logs${qs ? `?${qs}` : ''}`);
      return { content: [{ type: 'text', text: typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2) }] };
    },
  );

  server.registerTool(
    'get_pod_details',
    {
      description: 'Get detailed information about a specific pod including status, IP, node, and restart count',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        podName: z.string().describe('The pod name'),
      },
    },
    async ({ podName }) => {
      const pod = await client.get(`/pods/${podName}`);
      return { content: [{ type: 'text', text: JSON.stringify(pod, null, 2) }] };
    },
  );

  // ── Volumes ───────────────────────────────────────────────────────

  server.registerTool(
    'get_deployment_volumes',
    {
      description: 'Get all volumes attached to a deployment',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
      },
    },
    async ({ deploymentId }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      const volumes = deployment.volumes || [];
      return { content: [{ type: 'text', text: JSON.stringify(volumes, null, 2) }] };
    },
  );

  // ── GitHub ────────────────────────────────────────────────────────

  server.registerTool(
    'get_github_status',
    {
      description: "Check if the user's GitHub account is linked to Orchard. Required before deploying from GitHub repos.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const status = await client.get('/github/status');
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    'list_github_repos',
    {
      description: "List the user's GitHub repositories available for deployment",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const repos = await client.get('/github/repositories');
      return { content: [{ type: 'text', text: JSON.stringify(repos, null, 2) }] };
    },
  );

  server.registerTool(
    'list_github_app_repos',
    {
      description: 'List repositories from GitHub App installations (these have webhook support for auto-deploy)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const repos = await client.get('/github/app/repositories');
      return { content: [{ type: 'text', text: JSON.stringify(repos, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_branches',
    {
      description: 'Get branches for a GitHub repository',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner (GitHub username or org)'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const branches = await client.get(`/github/repositories/${owner}/${repo}/branches`);
      return { content: [{ type: 'text', text: JSON.stringify(branches, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_dockerfiles',
    {
      description: 'Find Dockerfiles in a GitHub repository. Useful to determine if a repo can be deployed and which Dockerfile to use.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const dockerfiles = await client.get(`/github/repositories/${owner}/${repo}/dockerfiles`);
      return { content: [{ type: 'text', text: JSON.stringify(dockerfiles, null, 2) }] };
    },
  );

  server.registerTool(
    'get_repo_contents',
    {
      description: 'Get the file/directory listing of a GitHub repository. Useful to analyze what the app needs.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        owner: z.string().describe('Repository owner'),
        repo: z.string().describe('Repository name'),
      },
    },
    async ({ owner, repo }) => {
      const contents = await client.get(`/github/repositories/${owner}/${repo}/contents`);
      return { content: [{ type: 'text', text: JSON.stringify(contents, null, 2) }] };
    },
  );

  // ── Templates ─────────────────────────────────────────────────────

  server.registerTool(
    'list_templates',
    {
      description: 'List all available templates (both built-in and custom)',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      const templates = await client.get('/templates');
      return { content: [{ type: 'text', text: JSON.stringify(templates, null, 2) }] };
    },
  );

  server.registerTool(
    'get_template',
    {
      description: 'Get a template by ID, including its full YAML definition and parameter schema',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        templateId: z.string().describe('The template UUID'),
      },
    },
    async ({ templateId }) => {
      const template = await client.get(`/templates/${templateId}`);
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    },
  );

  server.registerTool(
    'list_template_instances',
    {
      description: 'List all template instances (deployed templates) in a project',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        projectId: z.string().describe('The project UUID'),
      },
    },
    async ({ projectId }) => {
      const instances = await client.get(`/projects/${projectId}/template-instances`);
      return { content: [{ type: 'text', text: JSON.stringify(instances, null, 2) }] };
    },
  );

  server.registerTool(
    'get_template_instance',
    {
      description: 'Get details of a deployed template instance, including all created resources',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        instanceId: z.string().describe('The template instance UUID'),
      },
    },
    async ({ instanceId }) => {
      const instance = await client.get(`/template-instances/${instanceId}`);
      return { content: [{ type: 'text', text: JSON.stringify(instance, null, 2) }] };
    },
  );

  server.registerTool(
    'get_template_yaml_guide',
    {
      description: 'Get the full YAML format guide for creating Leaf templates, including all resource types, parameter types, interpolation syntax, and a complete example.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: 'text', text: YAML_FORMAT_GUIDE }] };
    },
  );
}

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
