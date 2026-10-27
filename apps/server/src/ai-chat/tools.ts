import OpenAI from 'openai';

// The apiFetch function signature: (method, path, body?) => Promise<any>
type ApiFetch = (method: string, path: string, body?: any) => Promise<any>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

const TOOLS: ToolDef[] = [
  // ── Query tools ──────────────────────────────────────────────────
  {
    name: 'get_current_user',
    description: "Get the currently authenticated user's profile information",
    parameters: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'list_organizations',
    description: 'List all organizations the authenticated user belongs to',
    parameters: { type: 'object' as const, properties: {}, required: [] }
  },
  {
    name: 'list_projects',
    description: 'List all projects in an organization',
    parameters: {
      type: 'object' as const,
      properties: {
        organizationId: { type: 'string', description: 'Organization UUID to filter by (optional)' }
      }
    }
  },
  {
    name: 'get_project',
    description: 'Get project details including deployments, databases, and ingresses',
    parameters: {
      type: 'object' as const,
      properties: { projectId: { type: 'string', description: 'The project UUID' } },
      required: ['projectId']
    }
  },
  {
    name: 'list_deployments',
    description: 'List all deployments in a project',
    parameters: {
      type: 'object' as const,
      properties: { projectId: { type: 'string', description: 'The project UUID' } },
      required: ['projectId']
    }
  },
  {
    name: 'get_deployment',
    description:
      'Get deployment details including status, image, replicas, env vars, services, and ingresses',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'get_pod_logs',
    description: 'Get runtime logs from a specific pod',
    parameters: {
      type: 'object' as const,
      properties: {
        podName: { type: 'string', description: 'The pod name' },
        namespace: { type: 'string', description: 'Kubernetes namespace (optional)' },
        tailLines: { type: 'number', description: 'Number of lines from the end (default 100)' }
      },
      required: ['podName']
    }
  },
  {
    name: 'list_pods',
    description: 'List running pods for a deployment',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'get_deployment_metrics',
    description: 'Fetch CPU/memory time-series metrics for a deployment',
    parameters: {
      type: 'object' as const,
      properties: {
        deploymentId: { type: 'string', description: 'The deployment UUID' },
        start: { type: 'number', description: 'Start timestamp in ms (default: 1h ago)' },
        end: { type: 'number', description: 'End timestamp in ms (default: now)' }
      },
      required: ['deploymentId']
    }
  },
  {
    name: 'get_database_metrics',
    description:
      'Fetch CPU/memory time-series metrics for a database pod. Use to confirm OOM patterns and size memory requests.',
    parameters: {
      type: 'object' as const,
      properties: {
        databaseId: { type: 'string', description: 'The database UUID' },
        start: { type: 'number', description: 'Start timestamp in ms (default: 1h ago)' },
        end: { type: 'number', description: 'End timestamp in ms (default: now)' },
        step: { type: 'number', description: 'Sample step in ms (default: 30000, min 1000)' }
      },
      required: ['databaseId']
    }
  },
  {
    name: 'list_databases',
    description: 'List PostgreSQL databases in a project',
    parameters: {
      type: 'object' as const,
      properties: { projectId: { type: 'string', description: 'The project UUID' } },
      required: ['projectId']
    }
  },
  {
    name: 'get_database',
    description:
      'Get database info (host, port, user, dbname; the password is never included, connection strings show it as ****) plus liveStatus with health: ready, phase, restartCount, message (e.g. "OOMKilled"), lastTerminationReason, lastTerminationExitCode, lastTerminationAt. Check liveStatus.message and liveStatus.lastTerminationReason to diagnose why a db is unhealthy — top-level status: "ready" only reflects provisioning state, not runtime health.',
    parameters: {
      type: 'object' as const,
      properties: { databaseId: { type: 'string', description: 'The database UUID' } },
      required: ['databaseId']
    }
  },
  {
    name: 'get_build_logs',
    description: 'Get Docker build output for a deployment',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'get_env_vars',
    description: 'Get the current environment variables for a deployment',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'list_ingresses',
    description: 'List all ingresses (public domains/routes) for a deployment',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'analyze_deployment_resources',
    description: 'Snapshot resource pressure for a deployment (CPU/memory usage ratio)',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },

  // ── Deployment actions ───────────────────────────────────────────
  {
    name: 'restart_deployment',
    description: 'Rolling restart of all pods in a deployment',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'rebuild_deployment',
    description: 'Rebuild a deployment from its GitHub source',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'scale_deployment',
    description: 'Scale a deployment to a specified number of replicas (0-10)',
    parameters: {
      type: 'object' as const,
      properties: {
        deploymentId: { type: 'string', description: 'The deployment UUID' },
        replicas: { type: 'number', description: 'Number of replicas (0-10)' }
      },
      required: ['deploymentId', 'replicas']
    }
  },

  // ── Configuration ────────────────────────────────────────────────
  {
    name: 'add_env_vars',
    description:
      'Add or update environment variables on a deployment (merges, does not remove existing). Keys that look like credentials are stored as sealed secrets unless secret is false; a sealed variable can never be made visible again.',
    parameters: {
      type: 'object' as const,
      properties: {
        deploymentId: { type: 'string', description: 'The deployment UUID' },
        envVars: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              secret: {
                type: 'boolean',
                description:
                  'Store as a sealed secret (write-only). Omit to keep the current flag, or to default by key name for new variables.'
              }
            },
            required: ['key', 'value']
          },
          description: 'Environment variable key-value pairs to add/update'
        }
      },
      required: ['deploymentId', 'envVars']
    }
  },
  {
    name: 'create_ingress',
    description: 'Create a public domain route with auto-TLS for a deployment',
    parameters: {
      type: 'object' as const,
      properties: {
        deploymentId: { type: 'string', description: 'The deployment UUID' },
        host: { type: 'string', description: 'The domain name (e.g. myapp.example.com)' },
        path: { type: 'string', description: 'URL path prefix (default: /)' },
        servicePort: { type: 'number', description: 'Service port to route to' }
      },
      required: ['deploymentId', 'host']
    }
  },

  // ── Resource creation ────────────────────────────────────────────
  {
    name: 'create_project',
    description: 'Create a new project in an organization',
    parameters: {
      type: 'object' as const,
      properties: {
        organizationId: { type: 'string', description: 'The organization UUID' },
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description (optional)' }
      },
      required: ['organizationId', 'name']
    }
  },
  {
    name: 'create_deployment',
    description: 'Create a new deployment from a Docker image',
    parameters: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project UUID' },
        name: { type: 'string', description: 'Deployment name' },
        image: { type: 'string', description: 'Docker image (e.g. nginx:latest)' },
        port: { type: 'number', description: 'Container port to expose' },
        replicas: { type: 'number', description: 'Number of replicas (default 1)' }
      },
      required: ['projectId', 'name', 'image']
    }
  },
  {
    name: 'deploy_from_github',
    description: 'Deploy from a GitHub repository (builds Docker image automatically)',
    parameters: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project UUID' },
        name: { type: 'string', description: 'Deployment name' },
        githubRepo: { type: 'string', description: 'GitHub repo in owner/repo format' },
        branch: { type: 'string', description: 'Branch to deploy (optional)' },
        dockerfilePath: { type: 'string', description: 'Path to Dockerfile (optional)' },
        port: { type: 'number', description: 'Container port to expose' }
      },
      required: ['projectId', 'name', 'githubRepo']
    }
  },
  {
    name: 'create_database',
    description: 'Create a new PostgreSQL database in a project',
    parameters: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project UUID' },
        name: { type: 'string', description: 'Database name' },
        storageSize: { type: 'string', description: 'Storage size (e.g. 1Gi, default 1Gi)' }
      },
      required: ['projectId', 'name']
    }
  },

  // ── Dangerous ────────────────────────────────────────────────────
  {
    name: 'delete_deployment',
    description:
      'Delete a deployment and all associated resources. This is destructive and cannot be undone.',
    parameters: {
      type: 'object' as const,
      properties: { deploymentId: { type: 'string', description: 'The deployment UUID' } },
      required: ['deploymentId']
    }
  },
  {
    name: 'delete_database',
    description:
      'Permanently destroy a PostgreSQL database. This is destructive and cannot be undone.',
    parameters: {
      type: 'object' as const,
      properties: { databaseId: { type: 'string', description: 'The database UUID' } },
      required: ['databaseId']
    }
  }
];

// Convert to OpenAI function-calling format
export const TOOLS_OPENAI: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS.map((t) => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
}));

type CurrentEnvVar = { key: string; value?: string | null; secret?: boolean };
type EnvVarPatch = { key: string; value: string; secret?: boolean };

export function mergeEnvForPut(
  current: CurrentEnvVar[],
  patch: EnvVarPatch[]
): { key: string; value: string | null; secret?: boolean }[] {
  const merged = new Map<string, { key: string; value: string | null; secret?: boolean }>();
  for (const v of current) {
    if (!v || typeof v.key !== 'string') continue;
    merged.set(v.key, {
      key: v.key,
      value: v.secret ? null : (v.value ?? null),
      secret: Boolean(v.secret)
    });
  }
  for (const v of patch) {
    if (!v || typeof v.key !== 'string' || !v.key.trim()) continue;
    const key = v.key.trim();
    merged.set(key, {
      key,
      value: String(v.value ?? ''),
      ...(typeof v.secret === 'boolean' ? { secret: v.secret } : {})
    });
  }
  return Array.from(merged.values());
}

// ── Tool executor ────────────────────────────────────────────────────
// Maps tool names to local API calls using the user's session token.

export async function executeTool(
  apiFetch: ApiFetch,
  name: string,
  input: Record<string, any>
): Promise<string> {
  switch (name) {
    // Query
    case 'get_current_user':
      return json(await apiFetch('GET', '/auth/me'));
    case 'list_organizations':
      return json(await apiFetch('GET', '/organizations/user'));
    case 'list_projects': {
      const url = input.organizationId ? `/projects?orgId=${input.organizationId}` : '/projects';
      return json(await apiFetch('GET', url));
    }
    case 'get_project':
      return json(await apiFetch('GET', `/projects/${input.projectId}`));
    case 'list_deployments':
      return json(await apiFetch('GET', `/projects/${input.projectId}/deployments`));
    case 'get_deployment':
      return json(await apiFetch('GET', `/deployments/${input.deploymentId}`));
    case 'get_pod_logs': {
      const qs = new URLSearchParams();
      if (input.namespace) qs.set('namespace', input.namespace);
      if (input.tailLines) qs.set('tailLines', String(input.tailLines));
      const q = qs.toString();
      return json(
        await apiFetch('GET', `/kubernetes/pods/${input.podName}/logs${q ? `?${q}` : ''}`)
      );
    }
    case 'list_pods':
      return json(await apiFetch('GET', `/deployments/${input.deploymentId}/pods`));
    case 'get_deployment_metrics': {
      const qs = new URLSearchParams();
      if (input.start) qs.set('start', String(input.start));
      if (input.end) qs.set('end', String(input.end));
      const q = qs.toString();
      return json(
        await apiFetch('GET', `/deployments/${input.deploymentId}/metrics${q ? `?${q}` : ''}`)
      );
    }
    case 'get_database_metrics': {
      const qs = new URLSearchParams();
      if (input.start) qs.set('start', String(input.start));
      if (input.end) qs.set('end', String(input.end));
      if (input.step) qs.set('step', String(input.step));
      const q = qs.toString();
      return json(
        await apiFetch('GET', `/databases/${input.databaseId}/metrics${q ? `?${q}` : ''}`)
      );
    }
    case 'list_databases':
      return json(await apiFetch('GET', `/projects/${input.projectId}/databases`));
    case 'get_database':
      return json(await apiFetch('GET', `/databases/${input.databaseId}`));
    case 'get_build_logs':
      return json(await apiFetch('GET', `/deployments/${input.deploymentId}/build-logs`));
    case 'get_env_vars': {
      const dep = await apiFetch('GET', `/deployments/${input.deploymentId}`);
      return json(dep.envVars || []);
    }
    case 'list_ingresses': {
      const dep = await apiFetch('GET', `/deployments/${input.deploymentId}`);
      return json(dep.ingresses || []);
    }
    case 'analyze_deployment_resources':
      return json(await apiFetch('GET', `/deployments/${input.deploymentId}/resource-analysis`));

    // Deployment actions
    case 'restart_deployment':
      return json(await apiFetch('POST', `/deployments/${input.deploymentId}/restart`));
    case 'rebuild_deployment':
      return json(await apiFetch('POST', `/deployments/${input.deploymentId}/rebuild`));
    case 'scale_deployment':
      return json(
        await apiFetch('PATCH', `/deployments/${input.deploymentId}/scale`, {
          replicas: input.replicas
        })
      );

    // Configuration
    case 'add_env_vars': {
      const dep = await apiFetch('GET', `/deployments/${input.deploymentId}`);
      return json(
        await apiFetch('PUT', `/deployments/${input.deploymentId}/env`, {
          env: mergeEnvForPut(dep?.envVars ?? [], input.envVars ?? [])
        })
      );
    }
    case 'create_ingress':
      return json(
        await apiFetch('POST', `/deployments/${input.deploymentId}/ingresses`, {
          host: input.host,
          path: input.path,
          servicePort: input.servicePort
        })
      );

    // Resource creation
    case 'create_project':
      return json(
        await apiFetch('POST', '/projects', {
          name: input.name,
          slug: input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, ''),
          organizationId: input.organizationId,
          description: input.description
        })
      );
    case 'create_deployment':
      return json(
        await apiFetch('POST', `/projects/${input.projectId}/deployments`, {
          name: input.name,
          image: input.image,
          port: input.port,
          replicas: input.replicas
        })
      );
    case 'deploy_from_github':
      return json(
        await apiFetch('POST', `/projects/${input.projectId}/deployments/github`, {
          name: input.name,
          githubRepo: input.githubRepo,
          branch: input.branch,
          dockerfilePath: input.dockerfilePath,
          port: input.port
        })
      );
    case 'create_database':
      return json(
        await apiFetch('POST', `/projects/${input.projectId}/databases`, {
          name: input.name,
          storageSize: input.storageSize
        })
      );

    // Dangerous
    case 'delete_deployment':
      return json(await apiFetch('DELETE', `/deployments/${input.deploymentId}`));
    case 'delete_database':
      return json(await apiFetch('DELETE', `/databases/${input.databaseId}`));

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

function json(data: any): string {
  return JSON.stringify(data, null, 2);
}
