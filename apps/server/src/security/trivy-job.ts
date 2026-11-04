import type * as k8s from '@kubernetes/client-node';
import { dockerConfigJson, type RegistryAuths } from '../docker/registry-pull-auth';

export const SCAN_LABEL = 'orchard.my/image-scan';
export const SCAN_TOKEN_HEADER = 'x-orchard-scan-token';
export const MAX_SCAN_ERROR = 900;
const SERVER_WAIT_TRIES = 30;

export interface RegistryTopology {
  pullRegistry: string;
  pushRegistry: string;
  httpHosts: Set<string>;
}

export interface ScanTarget {
  ref: string;
  host: string;
  insecure: boolean;
}

function splitHost(image: string): { host: string; rest: string } | null {
  const slash = image.indexOf('/');
  if (slash <= 0) return null;
  const host = image.slice(0, slash);
  if (!host.includes('.') && !host.includes(':') && host !== 'localhost') return null;
  return { host, rest: image.slice(slash + 1) };
}

function withHttpPort(host: string, httpHosts: Set<string>): string {
  return httpHosts.has(host) && !/:\d+$/.test(host) ? `${host}:80` : host;
}

export function scanTarget(image: string, topology: RegistryTopology): ScanTarget {
  const parts = splitHost(image);
  if (!parts) return { ref: image, host: 'docker.io', insecure: false };
  const { pullRegistry, pushRegistry, httpHosts } = topology;
  if (
    pullRegistry &&
    pushRegistry &&
    parts.host === pullRegistry &&
    pullRegistry !== pushRegistry
  ) {
    const host = withHttpPort(pushRegistry, httpHosts);
    return { ref: `${host}/${parts.rest}`, host, insecure: httpHosts.has(pushRegistry) };
  }
  return { ref: image, host: parts.host, insecure: httpHosts.has(parts.host) };
}

export function scanJobName(scanId: string): string {
  return `image-scan-${scanId.replace(/-/g, '').slice(0, 12)}`;
}

export interface ScanJobInput {
  scanId: string;
  namespace: string;
  trivyImage: string;
  serverUrl: string;
  resultUrl: string;
  target: ScanTarget;
  timeoutSeconds: number;
  withServerToken: boolean;
}

const SCRIPT = [
  'tries=0',
  `until wget -q -T 5 -O /dev/null "$TRIVY_SERVER/healthz" || [ "$tries" -ge ${SERVER_WAIT_TRIES} ]; do`,
  '  tries=$((tries + 1))',
  '  sleep 2',
  'done',
  'trivy image --no-progress --format json --scanners vuln --output /tmp/report.json "$SCAN_IMAGE" 2>/tmp/trivy.err',
  'status=$?',
  'if [ "$status" -ne 0 ]; then',
  `  msg=$(tail -c ${MAX_SCAN_ERROR} /tmp/trivy.err | tr '\\n\\t' '  ' | tr -cd ' -~' | tr -d '"\\\\')`,
  '  printf \'{"error":"%s"}\' "$msg" > /tmp/report.json',
  'fi',
  'wget -q -O /dev/null --header "X-Orchard-Scan-Token: $SCAN_TOKEN" --header "Content-Type: application/json" --post-file /tmp/report.json "$RESULT_URL"',
  'exit $status'
].join('\n');

export function scanJobManifest(input: ScanJobInput): k8s.V1Job {
  const name = scanJobName(input.scanId);
  const labels = {
    [SCAN_LABEL]: input.scanId,
    'app.kubernetes.io/name': 'image-scan',
    'app.kubernetes.io/part-of': 'orchard'
  };
  const fromSecret = (envName: string, key: string): k8s.V1EnvVar => ({
    name: envName,
    valueFrom: { secretKeyRef: { name, key } }
  });
  const env: k8s.V1EnvVar[] = [
    { name: 'SCAN_IMAGE', value: input.target.ref },
    { name: 'RESULT_URL', value: input.resultUrl },
    { name: 'TRIVY_SERVER', value: input.serverUrl },
    { name: 'TRIVY_TIMEOUT', value: `${Math.max(60, input.timeoutSeconds - 60)}s` },
    { name: 'TRIVY_CACHE_DIR', value: '/tmp/trivy' },
    { name: 'DOCKER_CONFIG', value: '/docker' },
    { name: 'HOME', value: '/tmp' },
    fromSecret('SCAN_TOKEN', 'scan-token')
  ];
  if (input.target.insecure) env.push({ name: 'TRIVY_INSECURE', value: 'true' });
  if (input.withServerToken) env.push(fromSecret('TRIVY_TOKEN', 'trivy-token'));

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: input.timeoutSeconds,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            fsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' }
          },
          containers: [
            {
              name: 'trivy',
              image: input.trivyImage,
              command: ['/bin/sh', '-c', SCRIPT],
              env,
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '1', memory: '1536Mi', 'ephemeral-storage': '8Gi' }
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] }
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'auth', mountPath: '/docker', readOnly: true }
              ]
            }
          ],
          volumes: [
            { name: 'tmp', emptyDir: { sizeLimit: '8Gi' } },
            {
              name: 'auth',
              secret: { secretName: name, items: [{ key: 'config.json', path: 'config.json' }] }
            }
          ]
        }
      }
    }
  };
}

export function scanSecretManifest(
  job: k8s.V1Job,
  input: { scanToken: string; serverToken: string | null; auths: RegistryAuths }
): k8s.V1Secret {
  const stringData: Record<string, string> = {
    'config.json': JSON.stringify(dockerConfigJson(input.auths)),
    'scan-token': input.scanToken
  };
  if (input.serverToken) stringData['trivy-token'] = input.serverToken;
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: job.metadata!.name,
      namespace: job.metadata!.namespace,
      labels: job.metadata!.labels,
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: job.metadata!.name!,
          uid: job.metadata!.uid!,
          blockOwnerDeletion: false
        }
      ]
    },
    stringData
  };
}

export function scanJobFailure(job: k8s.V1Job): string | null {
  const conditions = job.status?.conditions ?? [];
  const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed) {
    if (failed.reason === 'DeadlineExceeded') return 'The scan ran out of time';
    return failed.message || 'The scanner exited with an error';
  }
  const complete = conditions.find((c) => c.type === 'Complete' && c.status === 'True');
  if (complete) return 'The scan finished without reporting a result';
  return null;
}
