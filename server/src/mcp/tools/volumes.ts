import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OrchardClient } from '../client';

export function registerVolumeTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'get_deployment_volumes',
    {
      description: 'Get all volumes attached to a deployment',
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

  server.registerTool(
    'update_deployment_volumes',
    {
      description: `Update the volumes for a deployment. This replaces all existing volumes with the provided list.
Supported volume types:
- pvc: Persistent Volume Claim - persistent storage that survives pod restarts. Requires pvcName and optional storageSize (default: 1Gi). The PVC is automatically created in Kubernetes with the longhorn storage class.
- hostPath: Mount a file or directory from the host node's filesystem. Requires hostPath.
- emptyDir: Temporary storage that is created when a pod is assigned to a node and deleted when the pod is removed.

To remove all volumes, pass an empty array.`,
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
}
