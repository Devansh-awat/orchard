import * as k8s from '@kubernetes/client-node';
import { LABEL_JOB_ID } from '../jobs/jobs-orchestrator.service';
import { MirrorRefs, MirrorResourceConfig } from './mirror-informer';
import { PodMirrorConsumer } from './consumers/pod-mirror.consumer';
import { CnpgMirrorConsumer } from './consumers/cnpg-mirror.consumer';
import { JobMirrorConsumer } from './consumers/job-mirror.consumer';
import { WorkloadMirrorConsumer } from './consumers/workload-mirror.consumer';

const ORCHARD_SELECTOR = 'app.kubernetes.io/managed-by=orchard';
const INGRESS_SELECTOR = 'leaf.dev/managed=true';
const CNPG_POD_SELECTOR = 'cnpg.io/cluster';

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
  namespaceRefs: (namespace: string) => Promise<MirrorRefs>;
}

interface K8sListBody {
  body: { items?: any[]; metadata?: { resourceVersion?: string } };
}

function toListResult(res: K8sListBody): { items: any[]; resourceVersion: string } {
  return {
    items: res.body.items ?? [],
    resourceVersion: res.body.metadata?.resourceVersion ?? '',
  };
}

export function buildMirrorShards(deps: MirrorShardDeps): MirrorShardDef[] {
  const byNamespace = (obj: any) => deps.namespaceRefs(obj.metadata?.namespace ?? '');

  return [
    {
      name: 'pods',
      lease: 'orchard-mirror-pods',
      resources: [
        {
          kind: 'Pod',
          apiVersion: 'v1',
          watchPath: '/api/v1/pods',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.CoreV1Api)
                .listPodForAllNamespaces(undefined, undefined, undefined, ORCHARD_SELECTOR),
            ),
          mapRefs: (obj) => deps.pods.mapRefs(obj),
          onEvent: (type, obj) => deps.pods.onEvent(type, obj),
        },
      ],
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
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.CoreV1Api)
                .listPodForAllNamespaces(undefined, undefined, undefined, CNPG_POD_SELECTOR),
            ),
          mapRefs: (obj) => deps.cnpg.mapPodRefs(obj),
          onEvent: (type, obj) => deps.cnpg.onPodEvent(type, obj),
        },
        {
          kind: 'Cluster',
          apiVersion: 'postgresql.cnpg.io/v1',
          watchPath: '/apis/postgresql.cnpg.io/v1/clusters',
          list: async (kc) =>
            toListResult(
              (await kc
                .makeApiClient(k8s.CustomObjectsApi)
                .listClusterCustomObject('postgresql.cnpg.io', 'v1', 'clusters')) as K8sListBody,
            ),
          mapRefs: (obj) => deps.cnpg.mapClusterRefs(obj),
          onEvent: (type, obj) => deps.cnpg.onClusterEvent(type, obj),
        },
      ],
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
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.AppsV1Api)
                .listDeploymentForAllNamespaces(undefined, undefined, undefined, ORCHARD_SELECTOR),
            ),
          mapRefs: (obj) => deps.workloads.mapRefs(obj),
          onEvent: (type, obj) => deps.workloads.onEvent(type, obj),
        },
      ],
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
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.BatchV1Api)
                .listJobForAllNamespaces(undefined, undefined, undefined, LABEL_JOB_ID),
          ),
          mapRefs: (obj) => deps.jobs.mapRefs(obj),
          onEvent: (type, obj) => deps.jobs.onEvent(type, obj),
        },
        {
          kind: 'CronJob',
          apiVersion: 'batch/v1',
          watchPath: '/apis/batch/v1/cronjobs',
          labelSelector: LABEL_JOB_ID,
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.BatchV1Api)
                .listCronJobForAllNamespaces(undefined, undefined, undefined, LABEL_JOB_ID),
            ),
          mapRefs: (obj) => deps.jobs.mapRefs(obj),
        },
      ],
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
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.NetworkingV1Api)
                .listIngressForAllNamespaces(undefined, undefined, undefined, INGRESS_SELECTOR),
            ),
          mapRefs: byNamespace,
        },
        {
          kind: 'Service',
          apiVersion: 'v1',
          watchPath: '/api/v1/services',
          labelSelector: ORCHARD_SELECTOR,
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.CoreV1Api)
                .listServiceForAllNamespaces(undefined, undefined, undefined, ORCHARD_SELECTOR),
            ),
          mapRefs: byNamespace,
        },
      ],
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
          list: async (kc) =>
            toListResult(
              await kc
                .makeApiClient(k8s.CoreV1Api)
                .listPersistentVolumeClaimForAllNamespaces(
                  undefined,
                  undefined,
                  undefined,
                  ORCHARD_SELECTOR,
                ),
            ),
          mapRefs: byNamespace,
        },
      ],
    },
  ];
}
