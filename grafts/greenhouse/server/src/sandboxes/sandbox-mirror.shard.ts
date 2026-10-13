import * as k8s from '@kubernetes/client-node';
import type { MirrorResource, MirrorShard } from '@orchard/graft-sdk/server';
import { stripSecretData, toListResult, type K8sListBody } from '../core/mirror';
import {
  CRD_API_VERSION,
  CRD_GROUP,
  CRD_KIND,
  CRD_PLURAL,
  CRD_VERSION,
  INSTANCE_LABEL,
  SANDBOX_SHARD
} from './sandbox-cr';
import type { SandboxMirrorConsumer } from './sandbox-mirror.consumer';

export const SANDBOX_MIRROR_LEASE = 'orchard-mirror-sandboxes';

export interface SandboxMirrorScope {
  namespace: string;
  instanceId: string;
}

type ListFn = (
  kc: k8s.KubeConfig,
  opts: { continueToken?: string; limit?: number }
) => Promise<{ items: unknown[]; resourceVersion: string; continueToken: string | null }>;

const listing = (fn: ListFn): MirrorResource['list'] => fn as unknown as MirrorResource['list'];

const core = (kc: k8s.KubeConfig) => kc.makeApiClient(k8s.CoreV1Api);

export function sandboxMirrorShard(
  scope: SandboxMirrorScope,
  sandboxes: Pick<SandboxMirrorConsumer, 'onEvent' | 'onClaimEvent' | 'onListComplete'>
): MirrorShard {
  const { namespace, instanceId } = scope;
  const ownSelector = `${INSTANCE_LABEL}=${instanceId}`;
  return {
    name: SANDBOX_SHARD,
    lease: SANDBOX_MIRROR_LEASE,
    resources: [
      {
        kind: CRD_KIND,
        apiVersion: CRD_API_VERSION,
        watchPath: `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${namespace}/${CRD_PLURAL}`,
        labelSelector: ownSelector,
        list: listing(async (kc, opts) =>
          toListResult(
            (await kc
              .makeApiClient(k8s.CustomObjectsApi)
              .listNamespacedCustomObject(
                CRD_GROUP,
                CRD_VERSION,
                namespace,
                CRD_PLURAL,
                undefined,
                undefined,
                opts.continueToken,
                undefined,
                ownSelector,
                opts.limit
              )) as K8sListBody
          )
        ),
        onEvent: (type, obj) => sandboxes.onEvent(type as 'add' | 'update' | 'delete', obj),
        onListComplete: (seen) => sandboxes.onListComplete(seen as never)
      },
      {
        kind: 'Pod',
        apiVersion: 'v1',
        watchPath: `/api/v1/namespaces/${namespace}/pods`,
        labelSelector: ownSelector,
        list: listing(async (kc, opts) =>
          toListResult(
            await core(kc).listNamespacedPod(
              namespace,
              undefined,
              undefined,
              opts.continueToken,
              undefined,
              ownSelector,
              opts.limit
            )
          )
        )
      },
      {
        kind: 'PersistentVolumeClaim',
        apiVersion: 'v1',
        watchPath: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`,
        labelSelector: ownSelector,
        onEvent: (type, obj) => sandboxes.onClaimEvent(type as 'add' | 'update' | 'delete', obj),
        list: listing(async (kc, opts) =>
          toListResult(
            await core(kc).listNamespacedPersistentVolumeClaim(
              namespace,
              undefined,
              undefined,
              opts.continueToken,
              undefined,
              ownSelector,
              opts.limit
            )
          )
        )
      },
      {
        kind: 'Secret',
        apiVersion: 'v1',
        watchPath: `/api/v1/namespaces/${namespace}/secrets`,
        labelSelector: ownSelector,
        sanitize: stripSecretData,
        list: listing(async (kc, opts) => {
          const page = toListResult(
            await core(kc).listNamespacedSecret(
              namespace,
              undefined,
              undefined,
              opts.continueToken,
              undefined,
              ownSelector,
              opts.limit
            )
          );
          return { ...page, items: page.items.map(stripSecretData) };
        })
      }
    ]
  };
}
