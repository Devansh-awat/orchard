import * as k8s from '@kubernetes/client-node';
import { LABEL_JOB_ID } from '../jobs/jobs-orchestrator.service';
import { BUILDER_NAMESPACE } from '../docker/builder-namespace';
import {
  CRD_API_VERSION,
  CRD_GROUP,
  CRD_KIND,
  CRD_PLURAL,
  CRD_VERSION,
  INSTANCE_LABEL,
  SANDBOX_SHARD
} from '../sandboxes/sandbox-cr';
import {
  MirrorListOptions,
  MirrorListPage,
  MirrorRefs,
  MirrorResourceConfig
} from './mirror-informer';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { JobMirrorConsumer } from './consumers/job-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';
import { SandboxMirrorConsumer } from './consumers/sandbox-mirror.consumer';
import { IngressMirrorConsumer } from './consumers/ingress-mirror.consumer';
import { StorageMirrorConsumer } from './consumers/storage-mirror.consumer';
import { ServiceMirrorConsumer } from './consumers/service-mirror.consumer';
import { NamespaceMirrorConsumer } from './consumers/namespace-mirror.consumer';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
const INGRESS_SELECTOR = 'leaf.dev/managed=true';
const CNPG_POD_SELECTOR = 'cnpg.io/cluster';
const OUTSIDE_BUILDERS = `metadata.namespace!=${BUILDER_NAMESPACE}`;

export interface MirrorShardDef {
  name: string;
  lease: string;
  resources: MirrorResourceConfig[];
}

export interface MirrorShardDeps {
  pods: PodMirrorConsumer;
  cnpg: CnpgMirrorConsumer;
  jobs: JobMirrorConsumer;
  workloads: WorkloadMirrorConsumer;
  sandboxes: SandboxMirrorConsumer;
  ingresses: IngressMirrorConsumer;
  storage: StorageMirrorConsumer;
  services: ServiceMirrorConsumer;
  namespaces: NamespaceMirrorConsumer;
  // Whether cert-manager's CRDs are installed. Watching a kind the apiserver
  // does not serve fails the informer forever, so the resource is only built
  // when the definition exists.
  certManager: boolean;
  // Null when this install runs no sandboxes, or could not work out which
  // sandboxes are its own. The shard is then not built at all: there is no
  // useful half-scoped version of a watch whose whole job is to see exactly
  // this install's resources and nothing else.
  sandboxScope: { namespace: string; instanceId: string } | null;
  namespaceRefs: (namespace: string) => Promise<MirrorRefs>;
}

interface K8sListBody {
  body: {
    items?: any[];
    metadata?: { resourceVersion?: string; _continue?: string; continue?: string };
  };
}

// The typed clients deserialize ListMeta.continue to `_continue`; CustomObjectsApi
// hands back the raw JSON, where it stays `continue`.
function toListResult(res: K8sListBody): MirrorListPage {
  const meta = res.body.metadata ?? {};
  return {
    items: res.body.items ?? [],
    resourceVersion: meta.resourceVersion ?? '',
    continueToken: meta._continue ?? meta.continue ?? null
  };
}

export function buildMirrorShards(deps: MirrorShardDeps): MirrorShardDef[] {
  const byNamespace = (obj: any) => deps.namespaceRefs(obj.metadata?.namespace ?? '');

  const core = (kc: k8s.KubeConfig) => kc.makeApiClient(k8s.CoreV1Api);

  const listPods = async (
    kc: k8s.KubeConfig,
    opts: MirrorListOptions,
    labelSelector: string,
    fieldSelector?: string
  ): Promise<MirrorListPage> =>
    toListResult(
      await core(kc).listPodForAllNamespaces(
        undefined,
        opts.continueToken,
        fieldSelector,
        labelSelector,
        opts.limit
      )
    );

  const shards: MirrorShardDef[] = [
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
          mapRefs: (obj) => deps.jobs.mapRefs(obj)
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
                list: async (kc: k8s.KubeConfig, opts: MirrorListOptions) =>
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
              } satisfies MirrorResourceConfig
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

  if (deps.sandboxScope) {
    const { namespace, instanceId } = deps.sandboxScope;
    // Everything in this shard is selected by the instance label, so a second
    // Orchard server sharing the namespace is invisible to it rather than
    // merely ignored by it. That is what makes the orphan sweep at the end of a
    // list pass safe to act on.
    const ownSelector = `${INSTANCE_LABEL}=${instanceId}`;
    shards.push({
      name: SANDBOX_SHARD,
      lease: 'orchard-mirror-sandboxes',
      resources: [
        {
          kind: CRD_KIND,
          apiVersion: CRD_API_VERSION,
          watchPath: `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${namespace}/${CRD_PLURAL}`,
          labelSelector: ownSelector,
          list: async (kc, opts) =>
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
            ),
          onEvent: (type, obj) => deps.sandboxes.onEvent(type, obj),
          onListComplete: (seen) => deps.sandboxes.sweepOrphans(seen)
        },
        {
          // Held for lookups, not for derived state: exec, the SSH tunnel and
          // the git panel each need the running pod's name and IP, and they
          // used to pay a LIST to the apiserver for it on every request.
          kind: 'Pod',
          apiVersion: 'v1',
          watchPath: `/api/v1/namespaces/${namespace}/pods`,
          labelSelector: ownSelector,
          list: async (kc, opts) =>
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
        }
      ]
    });
  }

  return shards;
}
