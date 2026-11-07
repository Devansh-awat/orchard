import { randomBytes } from 'crypto';
import type * as k8s from '@kubernetes/client-node';
import { hardenedSecurityContext } from './trusted-images';

export const PSQL_APP_NAME = 'orchard-psql';
export const PSQL_CONTAINER = 'psql';
export const PSQL_SESSION_LABEL = 'orchard.my/psql-session';
export const PSQL_DATABASE_LABEL = 'orchard.my/database-id';
export const PSQL_USER_LABEL = 'orchard.my/session-user';
export const PSQL_ENV_MARKER = 'ORCHARD_PSQL_SESSION';
export const PSQL_SELECTOR = `${PSQL_SESSION_LABEL}=true`;

const POSTGRES_UID = 26;
const HOME_DIR = '/home/psql';
const DEFAULT_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 4 * 3600;
const DEFAULT_MAX_SESSIONS = 3;

export interface PsqlConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function psqlSessionTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return intFromEnv(
    env.PSQL_SESSION_TTL_SECONDS,
    DEFAULT_TTL_SECONDS,
    MIN_TTL_SECONDS,
    MAX_TTL_SECONDS
  );
}

export function psqlMaxSessions(env: NodeJS.ProcessEnv = process.env): number {
  return intFromEnv(env.PSQL_SESSIONS_PER_DATABASE, DEFAULT_MAX_SESSIONS, 1, 10);
}

export function psqlSessionName(): string {
  return `psql-${randomBytes(5).toString('hex')}`;
}

export function psqlSessionLabels(databaseId: string, userId: string): Record<string, string> {
  return {
    'app.kubernetes.io/managed-by': 'orchard',
    'app.kubernetes.io/name': PSQL_APP_NAME,
    [PSQL_SESSION_LABEL]: 'true',
    [PSQL_DATABASE_LABEL]: databaseId,
    [PSQL_USER_LABEL]: userId
  };
}

export function psqlSessionSecret(input: {
  name: string;
  namespace: string;
  databaseId: string;
  userId: string;
  connection: PsqlConnection;
  owner: { name: string; uid: string };
}): k8s.V1Secret {
  const { connection: c } = input;
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: psqlSessionLabels(input.databaseId, input.userId),
      ownerReferences: [
        {
          apiVersion: 'v1',
          kind: 'Pod',
          name: input.owner.name,
          uid: input.owner.uid,
          blockOwnerDeletion: false
        }
      ]
    },
    stringData: {
      PGHOST: c.host,
      PGPORT: String(c.port),
      PGUSER: c.user,
      PGPASSWORD: c.password,
      PGDATABASE: c.database
    }
  };
}

export function psqlSessionPod(input: {
  name: string;
  namespace: string;
  image: string;
  databaseId: string;
  userId: string;
  runtimeClassName?: string;
  ttlSeconds: number;
}): k8s.V1Pod {
  const security = hardenedSecurityContext();
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: psqlSessionLabels(input.databaseId, input.userId)
    },
    spec: {
      ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      activeDeadlineSeconds: input.ttlSeconds,
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: POSTGRES_UID,
        runAsGroup: POSTGRES_UID,
        seccompProfile: security.seccompProfile
      },
      containers: [
        {
          name: PSQL_CONTAINER,
          image: input.image,
          imagePullPolicy: 'IfNotPresent',
          command: ['sleep', String(input.ttlSeconds)],
          envFrom: [{ secretRef: { name: input.name } }],
          env: [
            { name: PSQL_ENV_MARKER, value: '1' },
            { name: 'HOME', value: HOME_DIR },
            { name: 'PGAPPNAME', value: 'orchard-psql' },
            { name: 'PGCONNECT_TIMEOUT', value: '10' }
          ],
          securityContext: {
            ...security,
            capabilities: { drop: ['ALL'] },
            readOnlyRootFilesystem: true,
            runAsNonRoot: true
          },
          resources: {
            requests: { cpu: '50m', memory: '64Mi', 'ephemeral-storage': '16Mi' },
            limits: { cpu: '250m', memory: '256Mi', 'ephemeral-storage': '64Mi' }
          },
          volumeMounts: [
            { name: 'home', mountPath: HOME_DIR },
            { name: 'tmp', mountPath: '/tmp' }
          ]
        }
      ],
      volumes: [
        { name: 'home', emptyDir: { sizeLimit: '16Mi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '16Mi' } }
      ]
    }
  };
}

export type PsqlPodState =
  | { state: 'ready' }
  | { state: 'pending' }
  | { state: 'failed'; reason: string };

const FATAL_WAITING =
  /^(ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError|RunContainerError)$/;

export function psqlPodState(pod: k8s.V1Pod): PsqlPodState {
  const phase = pod.status?.phase;
  if (phase === 'Failed' || phase === 'Succeeded') {
    return { state: 'failed', reason: pod.status?.reason || `pod ${phase.toLowerCase()}` };
  }
  const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
  if (waiting?.reason && FATAL_WAITING.test(waiting.reason)) {
    return { state: 'failed', reason: waiting.message || waiting.reason };
  }
  const running = pod.status?.containerStatuses?.[0]?.state?.running;
  if (phase === 'Running' && running) return { state: 'ready' };
  return { state: 'pending' };
}

export function isPsqlSessionPod(pod: k8s.V1Pod | null | undefined): boolean {
  return pod?.metadata?.labels?.[PSQL_SESSION_LABEL] === 'true';
}

export function isStalePsqlPod(
  pod: k8s.V1Pod,
  now: number,
  liveDatabaseIds: ReadonlySet<string>,
  ttlSeconds: number = psqlSessionTtlSeconds()
): boolean {
  if (!isPsqlSessionPod(pod)) return false;
  const phase = pod.status?.phase;
  if (phase === 'Failed' || phase === 'Succeeded') return true;
  const databaseId = pod.metadata?.labels?.[PSQL_DATABASE_LABEL];
  if (!databaseId || !liveDatabaseIds.has(databaseId)) return true;
  const created = pod.metadata?.creationTimestamp
    ? new Date(pod.metadata.creationTimestamp).getTime()
    : NaN;
  if (!Number.isFinite(created)) return false;
  return now - created > (ttlSeconds + 120) * 1000;
}
