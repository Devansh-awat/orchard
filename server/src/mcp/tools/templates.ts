import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

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

export function registerTemplateTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_templates',
    {
      description: 'List all available templates (both built-in and custom)',
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
    'create_template',
    {
      description: `Create a custom template from a YAML definition. The YAML must follow the leaf/v1 template format.

${YAML_FORMAT_GUIDE}`,
      inputSchema: {
        yaml: z.string().describe('The full YAML template definition following the leaf/v1 format'),
      },
    },
    async ({ yaml }) => {
      const template = await client.post('/templates', { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    },
  );

  server.registerTool(
    'update_template',
    {
      description: 'Update an existing custom template with a new YAML definition. Built-in templates cannot be updated.',
      inputSchema: {
        templateId: z.string().describe('The template UUID to update'),
        yaml: z.string().describe('The updated YAML template definition'),
      },
    },
    async ({ templateId, yaml }) => {
      const template = await client.put(`/templates/${templateId}`, { yaml });
      return { content: [{ type: 'text', text: JSON.stringify(template, null, 2) }] };
    },
  );

  server.registerTool(
    'delete_template',
    {
      description: 'Delete a custom template. Built-in templates cannot be deleted.',
      inputSchema: {
        templateId: z.string().describe('The template UUID to delete'),
      },
    },
    async ({ templateId }) => {
      await client.delete(`/templates/${templateId}`);
      return { content: [{ type: 'text', text: 'Template deleted successfully.' }] };
    },
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
        projectId: z.string().describe('The project UUID to deploy the template into'),
        templateId: z.string().describe('The template UUID to deploy'),
        parameters: z.record(z.any()).describe('Parameter values as a JSON object, e.g. { "appName": "my-app", "image": "nginx:latest", "port": 3000 }'),
      },
    },
    async ({ projectId, templateId, parameters }) => {
      const instance = await client.post(`/projects/${projectId}/template-instances`, {
        templateId,
        parameters,
      });
      return { content: [{ type: 'text', text: JSON.stringify(instance, null, 2) }] };
    },
  );

  server.registerTool(
    'list_template_instances',
    {
      description: 'List all template instances (deployed templates) in a project',
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
    'delete_template_instance',
    {
      description: 'Delete a template instance and all its associated resources (deployments, databases, ingresses). This is a destructive operation.',
      inputSchema: {
        instanceId: z.string().describe('The template instance UUID to delete'),
      },
    },
    async ({ instanceId }) => {
      const result = await client.delete(`/template-instances/${instanceId}`);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'get_template_yaml_guide',
    {
      description: 'Get the full YAML format guide for creating Leaf templates, including all resource types, parameter types, interpolation syntax, and a complete example.',
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: 'text', text: YAML_FORMAT_GUIDE }] };
    },
  );
}
