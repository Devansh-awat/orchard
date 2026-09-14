import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient } from '../client';

interface EnvVarInput {
  key: string;
  value: string | null;
  secret?: boolean;
}

export function registerConfigurationTools(server: McpServer, client: OrchardClient) {
  // ── Environment Variables ─────────────────────────────────────────

  server.registerTool(
    'set_env_vars',
    {
      description: `Set or update environment variables on a deployment. This will restart the deployment to apply changes.
Provide the full list of env vars — any existing vars not included will be removed.
Common env vars to suggest: DATABASE_URL (if using a database), PORT, NODE_ENV, etc.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        envVars: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
          secret: z.boolean().optional()
            .describe('Store in the deployment Kubernetes Secret. Write-only: reads never return it'),
        })).describe('Array of environment variable key-value pairs'),
      },
    },
    async ({ deploymentId, envVars }) => {
      const result = await client.put(`/deployments/${deploymentId}/env`, { env: envVars });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'add_env_vars',
    {
      description: `Add or update specific environment variables on a deployment without affecting other existing vars.
This fetches the current env vars, merges in the provided ones (overwriting any with the same key), and applies the result. The deployment will restart.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        envVars: z.array(z.object({
          key: z.string().describe('Environment variable name'),
          value: z.string().describe('Environment variable value'),
          secret: z.boolean().optional()
            .describe('Store in the deployment Kubernetes Secret. Write-only: reads never return it'),
        })).describe('Array of environment variable key-value pairs to add or update'),
      },
    },
    async ({ deploymentId, envVars }) => {
      const deployment = await client.get(`/deployments/${deploymentId}`);
      // A secret reads back with no value and its flag intact. Carrying both
      // over is what keeps this a merge: a null value tells the server to keep
      // what is stored, and dropping the flag would ask it to republish a
      // secret in the clear, which it refuses.
      const existing: EnvVarInput[] = (deployment.envVars || []).map(
        (v: EnvVarInput) => ({ key: v.key, value: v.value ?? null, secret: v.secret }),
      );

      const newKeys = new Set(envVars.map((v) => v.key));
      const merged = [
        ...existing.filter((v) => !newKeys.has(v.key)),
        ...envVars,
      ];

      const result = await client.put(`/deployments/${deploymentId}/env`, { env: merged });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Volumes ───────────────────────────────────────────────────────

  server.registerTool(
    'update_deployment_volumes',
    {
      description: `Update the volumes for a deployment. This replaces all existing volumes with the provided list.
Supported volume types:
- pvc: Persistent Volume Claim - persistent storage that survives pod restarts. Requires pvcName and optional storageSize (default: 1Gi). The PVC is automatically created in Kubernetes with the longhorn storage class.
- hostPath: Mount a file or directory from the host node's filesystem. Requires hostPath.
- emptyDir: Temporary storage that is created when a pod is assigned to a node and deleted when the pod is removed.

To remove all volumes, pass an empty array.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        volumes: z.array(z.object({
          name: z.string().describe('Volume name (unique within deployment)'),
          type: z.enum(['pvc', 'hostPath', 'emptyDir']).describe('Volume type'),
          mountPath: z.string().describe('Path inside the container to mount the volume'),
          pvcName: z.string().optional().describe('PVC name (required for pvc type). The PVC will be auto-created if it does not exist.'),
          storageSize: z.string().optional().describe('Storage size for PVC (e.g. 1Gi, 5Gi, 10Gi). Default: 1Gi'),
          hostPath: z.string().optional().describe('Host path (required for hostPath type)'),
          readOnly: z.boolean().optional().describe('Mount as read-only (default: false)'),
        })).describe('List of volumes to attach'),
      },
    },
    async ({ deploymentId, volumes }) => {
      const result = await client.put(`/deployments/${deploymentId}/volumes`, { volumes });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Image & deploy strategy ───────────────────────────────────────

  server.registerTool(
    'update_deployment_image',
    {
      description: `Change the Docker image of an image-source deployment (one created from an image reference, not built from a GitHub repo). Pods will roll to pull the new image.
Only valid for non-GitHub deployments — for GitHub deployments use \`rebuild_deployment\` so the image is rebuilt from source. The backend rejects this on a GitHub-built deployment with a clear error.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        image: z.string().describe('New Docker image reference (e.g. nginx:1.27, ghcr.io/org/app:v2.1.0)'),
      },
    },
    async ({ deploymentId, image }) => {
      const result = await client.patch(`/deployments/${deploymentId}/image`, { image });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_deployment_strategy',
    {
      description: `Set the Kubernetes update strategy for a deployment.
- \`rollingUpdate\`: bring up new pods before draining old ones — zero downtime.
- \`recreate\`: tear down all pods first, then start new ones — brief downtime, required for ReadWriteOnce PVCs.

When the deployment has a PVC attached, the backend forces \`recreate\` and rejects attempts to set \`rollingUpdate\` (the response will say so). If you must switch back, remove the PVC first via \`update_deployment_volumes\`.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        strategy: z.enum(['rollingUpdate', 'recreate']).describe('The new update strategy'),
      },
    },
    async ({ deploymentId, strategy }) => {
      const result = await client.patch(`/deployments/${deploymentId}/strategy`, { strategy });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'update_deployment_pull_policy',
    {
      description: `Override whether Kubernetes re-pulls the container image every time a pod starts.

You usually do not need this. By default the policy is derived from the tag: a tag that can move (\`latest\`, \`main\`, \`stable\`, a floating major like \`17\`, or no tag at all) gets \`Always\`, and a pinned tag or digest gets \`IfNotPresent\`. Change the image and it re-derives.

Set it only to override that:
- \`Always\`: re-pull on every pod start, so push-then-\`restart_deployment\` picks up a new build.
- \`IfNotPresent\`: reuse the layer cached on the node. On a moving tag this means a restart will NOT show a new push.
- \`null\`: clear the override and go back to deriving it from the tag.

An explicit value here survives an image change, which is the point: it is your call, not a guess.

Changing this rolls the pods on its own; no separate restart is needed.`,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        imagePullPolicy: z
          .enum(['Always', 'IfNotPresent'])
          .nullable()
          .describe('The pull policy to pin, or null to go back to automatic'),
      },
    },
    async ({ deploymentId, imagePullPolicy }) => {
      const result = await client.patch(`/deployments/${deploymentId}/pull-policy`, {
        imagePullPolicy,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── Networking ────────────────────────────────────────────────────

  server.registerTool(
    'create_ingress',
    {
      description: `Create a public ingress (domain route) for a deployment. This makes the deployment accessible via a domain name with automatic TLS.
The user must point their domain's DNS to the cluster before creating the ingress. Use validate_dns to check.`,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID to route traffic to'),
        host: z.string().describe('The domain name (e.g. myapp.example.com)'),
        path: z.string().optional().describe('URL path prefix (default: /)'),
        servicePort: z.number().optional().describe('The service port to route to (default: 80)'),
      },
    },
    async ({ deploymentId, host, path, servicePort }) => {
      const ingress = await client.post(`/deployments/${deploymentId}/ingresses`, {
        host,
        path: path ?? '/',
        servicePort: servicePort ?? 80,
      });
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'update_ingress',
    {
      description: 'Update an existing ingress configuration',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        ingressId: z.string().describe('The ingress UUID to update'),
        host: z.string().describe('The domain name (e.g. myapp.example.com)'),
        path: z.string().optional().describe('URL path prefix'),
        servicePort: z.number().optional().describe('The service port to route to'),
      },
    },
    async ({ deploymentId, ingressId, host, path, servicePort }) => {
      const body: Record<string, any> = { host };
      if (path !== undefined) body.path = path;
      if (servicePort !== undefined) body.servicePort = servicePort;
      const ingress = await client.put(`/deployments/${deploymentId}/ingresses/${ingressId}`, body);
      return { content: [{ type: 'text', text: JSON.stringify(ingress, null, 2) }] };
    },
  );

  server.registerTool(
    'create_service',
    {
      description: 'Create an internal or external service for a deployment to expose ports',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        deploymentId: z.string().describe('The deployment UUID'),
        name: z.string().describe('Service name'),
        type: z.enum(['internal', 'external']).describe('Service type: internal (ClusterIP) or external (NodePort/LoadBalancer)'),
        port: z.number().describe('Service port (the port exposed by the service)'),
        targetPort: z.number().describe('Container port to route to'),
      },
    },
    async ({ deploymentId, name, type, port, targetPort }) => {
      const service = await client.post(`/deployments/${deploymentId}/services`, {
        name,
        exposePublic: type === 'external',
        ports: [
          {
            containerPort: Number(targetPort),
            servicePort: Number(port),
            protocol: 'TCP',
          },
        ],
      });
      return { content: [{ type: 'text', text: JSON.stringify(service, null, 2) }] };
    },
  );
}
