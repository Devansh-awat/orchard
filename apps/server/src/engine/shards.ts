import * as k8s from '@kubernetes/client-node';
import { LABEL_JOB_ID } from '../jobs/jobs-orchestrator.service';
import { BUILDER_NAMESPACE } from '../docker/builder-namespace';
import {
  EngineListOptions,
  EngineListPage,
  EngineRefs,
  EngineResource,
  EngineShard,
  K8sListBody,
  toListResult
} from './core';
import { PodConsumer } from './consumers/pod.consumer';
import { CnpgConsumer } from './consumers/cnpg.consumer';
import { JobConsumer } from './consumers/job.consumer';
import { CronJobConsumer } from './consumers/cronjob.consumer';
import { WorkloadConsumer } from './consumers/workload.consumer';
import { IngressConsumer } from './consumers/ingress.consumer';
import { StorageConsumer } from './consumers/storage.consumer';
import { ServiceConsumer } from './consumers/service.consumer';
import { NamespaceConsumer } from './consumers/namespace.consumer';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
const INGRESS_SELECTOR = 'leaf.dev/managed=true';
const CNPG_POD_SELECTOR = 'cnpg.io/cluster';
const OUTSIDE_BUILDERS = `metadata.namespace!=${BUILDER_NAMESPACE}`;

export interface EngineShardDeps {
  pods: PodConsumer;
  cnpg: CnpgConsumer;
  jobs: JobConsumer;
  cronJobs: CronJobConsumer;
  workloads: WorkloadConsumer;
  ingresses: IngressConsumer;
  storage: StorageConsumer;
  services: ServiceConsumer;
  namespaces: NamespaceConsumer;
  // Whether cert-manager's CRDs are installed. Watching a kind the apiserver
  // does not serve fails the informer forever, so the resource is only built
  // when the definition exists.
  certManager: boolean;
  namespaceRefs: (namespace: string) => Promise<EngineRefs>;
}

export { stripSecretData, toListResult } from './core';
export type { EngineShard } from './core';

export type EngineShardBuilder = () => Promise<EngineShard | null>;

const extensionShards: EngineShardBuilder[] = [];

export function registerEngineShard(build: EngineShardBuilder): void {
  extensionShards.push(build);
}

export function registeredEngineShards(): readonly EngineShardBuilder[] {
  return extensionShards;
}

export function buildEngineShards(deps: EngineShardDeps): EngineShard[] {
  const byNamespace = (obj: any) => deps.namespaceRefs(obj.metadata?.namespace ?? '');

  const core = (kc: k8s.KubeConfig) => kc.makeApiClient(k8s.CoreV1Api);

  const listPods = async (
    kc: k8s.KubeConfig,
    opts: EngineListOptions,
    labelSelector: string,
    fieldSelector?: string
  ): Promise<EngineListPage> =>
    toListResult(
      await core(kc).listPodForAllNamespaces(
        undefined,
        opts.continueToken,
        fieldSelector,
        labelSelector,
        opts.limit
      )
    );

  const shards: EngineShard[] = [
    {
      name: 'pods',
      lease: 'orchard-mirror-pods',
      resources: [
        {
          kind: 'Pod',
          apiVersion: 'v1',
          watchPath: '/api/v1/pods',
          labelSelector: ORCHARD_SELECTOR,
          fieldSelector: OUTSIDE_BUILDERS,
          list: (kc, opts) => listPods(kc, opts, ORCHARD_SELECTOR, OUTSIDE_BUILDERS),
          mapRefs: (obj) => deps.pods.mapRefs(obj),
          onEvent: (type, obj) => deps.pods.onEvent(type, obj),
          onListComplete: (seen) => deps.pods.pruneStalePods(seen)
        }
      ]
    },
    {
      name: 'cnpg',
      lease: 'orchard-mirror-cnpg',
      resources: [
        {
          kind: 'Pod',
          apiVersion: 'v1',
          watchPath: '/api/v1/pods',
          labelSelector: CNPG_POD_SELECTOR,
          list: (kc, opts) => listPods(kc, opts, CNPG_POD_SELECTOR),
          mapRefs: (obj) => deps.cnpg.mapPodRefs(obj),
          onEvent: (type, obj) => deps.cnpg.onPodEvent(type, obj),
          onListComplete: (seen) => deps.cnpg.pruneStalePods(seen)
        },
        {
          kind: 'Cluster',
          apiVersion: 'postgresql.cnpg.io/v1',
          watchPath: '/apis/postgresql.cnpg.io/v1/clusters',
          list: async (kc, opts) =>
            toListResult(
              (await kc
                .makeApiClient(k8s.CustomObjectsApi)
                .listClusterCustomObject(
                  'postgresql.cnpg.io',
                  'v1',
                  'clusters',
                  undefined,
                  undefined,
                  opts.continueToken,
                  undefined,
                  undefined,
                  opts.limit
                )) as K8sListBody
            ),
          mapRefs: (obj) => deps.cnpg.mapClusterRefs(obj),
          onEvent: (type, obj) => deps.cnpg.onClusterEvent(type, obj)
        },
        {
          kind: 'ScheduledBackup',
          apiVersion: 'postgresql.cnpg.io/v1',
          watchPath: '/apis/postgresql.cnpg.io/v1/scheduledbackups',
          list: async (kc, opts) =>
            toListResult(
              (await kc
                .makeApiClient(k8s.CustomObjectsApi)
                .listClusterCustomObject(
                  'postgresql.cnpg.io',
                  'v1',
                  'scheduledbackups',
                  undefined,
                  undefined,
                  opts.continueToken,
                  undefined,
                  undefined,
                  opts.limit
                )) as K8sListBody
            ),
          mapRefs: (obj) => deps.cnpg.mapScheduledBackupRefs(obj),
          onEvent: (type, obj) => deps.cnpg.onScheduledBackupEvent(type, obj)
        }
      ]
    },
    {
      name: 'workloads',
      lease: 'orchard-mirror-workloads',
      resources: [
        {
          kind: 'Deployment',
          apiVersion: 'apps/v1',
          watchPath: '/apis/apps/v1/deployments',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc, opts) =>
            toListResult(
              await kc
                .makeApiClient(k8s.AppsV1Api)
                .listDeploymentForAllNamespaces(
                  undefined,
                  opts.continueToken,
                  undefined,
                  ORCHARD_SELECTOR,
                  opts.limit
                )
            ),
          mapRefs: (obj) => deps.workloads.mapRefs(obj),
          onEvent: (type, obj) => deps.workloads.onEvent(type, obj)
        },
        {
          kind: 'PodDisruptionBudget',
          apiVersion: 'policy/v1',
          watchPath: '/apis/policy/v1/poddisruptionbudgets',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc, opts) =>
            toListResult(
              await kc
                .makeApiClient(k8s.PolicyV1Api)
                .listPodDisruptionBudgetForAllNamespaces(
                  undefined,
                  opts.continueToken,
                  undefined,
                  ORCHARD_SELECTOR,
                  opts.limit
                )
            ),
          mapRefs: (obj) => deps.workloads.mapPdbRefs(obj),
          onEvent: (type, obj) => deps.workloads.onPdbEvent(type, obj)
        }
      ]
    },
    {
      name: 'batch',
      lease: 'orchard-mirror-batch',
      resources: [
        {
          kind: 'Job',
          apiVersion: 'batch/v1',
          watchPath: '/apis/batch/v1/jobs',
          labelSelector: LABEL_JOB_ID,
          list: async (kc, opts) =>
            toListResult(
              await kc
                .makeApiClient(k8s.BatchV1Api)
                .listJobForAllNamespaces(
                  undefined,
                  opts.continueToken,
                  undefined,
                  LABEL_JOB_ID,
                  opts.limit
                )
            ),
          mapRefs: (obj) => deps.jobs.mapRefs(obj),
          onEvent: (type, obj) => deps.jobs.onEvent(type, obj)
        },
        {
          kind: 'CronJob',
          apiVersion: 'batch/v1',
          watchPath: '/apis/batch/v1/cronjobs',
          labelSelector: LABEL_JOB_ID,
          list: async (kc, opts) =>
            toListResult(
              await kc
                .makeApiClient(k8s.BatchV1Api)
                .listCronJobForAllNamespaces(
                  undefined,
                  opts.continueToken,
                  undefined,
                  LABEL_JOB_ID,
                  opts.limit
                )
            ),
          mapRefs: (obj) => deps.cronJobs.mapRefs(obj),
          onEvent: (type, obj) => deps.cronJobs.onEvent(type, obj)
        }
      ]
    },
    {
      name: 'net',
      lease: 'orchard-mirror-net',
      resources: [
        {
          kind: 'Ingress',
          apiVersion: 'networking.k8s.io/v1',
          watchPath: '/apis/networking.k8s.io/v1/ingresses',
          labelSelector: INGRESS_SELECTOR,
          list: async (kc, opts) =>
            toListResult(
              await kc
                .makeApiClient(k8s.NetworkingV1Api)
                .listIngressForAllNamespaces(
                  undefined,
                  opts.continueToken,
                  undefined,
                  INGRESS_SELECTOR,
                  opts.limit
                )
            ),
          mapRefs: byNamespace,
          onEvent: (type, obj) => deps.ingresses.onEvent(type, obj),
          onListComplete: (seen) => deps.ingresses.pruneStaleRows(seen)
        },
        {
          kind: 'Service',
          apiVersion: 'v1',
          watchPath: '/api/v1/services',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc, opts) =>
            toListResult(
              await core(kc).listServiceForAllNamespaces(
                undefined,
                opts.continueToken,
                undefined,
                ORCHARD_SELECTOR,
                opts.limit
              )
            ),
          mapRefs: async (obj) => (await deps.services.mapRefs(obj)) ?? byNamespace(obj),
          onEvent: (type, obj) => deps.services.onEvent(type, obj),
          onListComplete: (seen) => deps.services.pruneStaleRows(seen)
        },
        ...(deps.certManager
          ? [
              {
                kind: 'Certificate',
                apiVersion: 'cert-manager.io/v1',
                watchPath: '/apis/cert-manager.io/v1/certificates',
                list: async (kc: k8s.KubeConfig, opts: EngineListOptions) =>
                  toListResult(
                    (await kc
                      .makeApiClient(k8s.CustomObjectsApi)
                      .listClusterCustomObject(
                        'cert-manager.io',
                        'v1',
                        'certificates',
                        undefined,
                        undefined,
                        opts.continueToken,
                        undefined,
                        undefined,
                        opts.limit
                      )) as K8sListBody
                  ),
                mapRefs: byNamespace
              } satisfies EngineResource
            ]
          : [])
      ]
    },
    {
      name: 'tenancy',
      lease: 'orchard-mirror-tenancy',
      resources: [
        {
          kind: 'Namespace',
          apiVersion: 'v1',
          watchPath: '/api/v1/namespaces',
          list: async (kc, opts) =>
            toListResult(
              await core(kc).listNamespace(
                undefined,
                undefined,
                opts.continueToken,
                undefined,
                undefined,
                opts.limit
              )
            ),
          mapRefs: (obj) => deps.namespaceRefs(obj.metadata?.name ?? ''),
          onEvent: (type, obj) => deps.namespaces.onEvent(type, obj),
          onListComplete: (seen) => deps.namespaces.pruneMissing(seen)
        }
      ]
    },
    {
      name: 'storage',
      lease: 'orchard-mirror-storage',
      resources: [
        {
          kind: 'PersistentVolumeClaim',
          apiVersion: 'v1',
          watchPath: '/api/v1/persistentvolumeclaims',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc, opts) =>
            toListResult(
              await core(kc).listPersistentVolumeClaimForAllNamespaces(
                undefined,
                opts.continueToken,
                undefined,
                ORCHARD_SELECTOR,
                opts.limit
              )
            ),
          mapRefs: async (obj) => (await deps.storage.mapRefs(obj)) ?? byNamespace(obj),
          onEvent: (type, obj) => deps.storage.onEvent(type, obj)
        }
      ]
    }
  ];

  return shards;
}
