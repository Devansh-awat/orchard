import * as k8s from '@kubernetes/client-node';
import { parseCpu, parseMemory } from './quantity';

// A cluster-wide pod LIST is ~8MB and takes seconds on a real cluster, and a
// single load of the usage page wants four of them plus three service LISTs:
// /quota, /quota/me, and /quota/projects each need their own, and
// /quota/projects needs two. They all want the same snapshot at the same instant.
//
// So: one snapshot, shared. Single-flight collapses the parallel burst into one
// request, and a short TTL covers the SSE-driven refetches that follow.
//
// Deliberately a plain module rather than a Nest provider. KubernetesService
// owns the KubeConfig and is also a caller, so a service here would close a
// dependency cycle, and swc turns those into a TDZ crash at boot.

const TTL_MS = Number(process.env.CLUSTER_SNAPSHOT_TTL_MS) || 10_000;

export interface PodSnapshot {
  nodeName: string | null;
  namespace: string;
  podName: string;
  phase: string | null;
  cpuRequestMilli: number;
  memoryRequestBytes: number;
  cpuLimitMilli: number;
  memoryLimitBytes: number;
  labels: Record<string, string>;
}

interface Entry<T> {
  at: number;
  value: T;
}

let podCache: Entry<PodSnapshot[]> | null = null;
let podInFlight: Promise<PodSnapshot[]> | null = null;

let svcCache: Entry<Map<string, number>> | null = null;
let svcInFlight: Promise<Map<string, number>> | null = null;

const fresh = <T>(e: Entry<T> | null): e is Entry<T> => !!e && Date.now() - e.at < TTL_MS;

function projectPod(pod: k8s.V1Pod): PodSnapshot {
  let cpuRequestMilli = 0;
  let memoryRequestBytes = 0;
  let cpuLimitMilli = 0;
  let memoryLimitBytes = 0;
  for (const c of pod.spec?.containers ?? []) {
    // Requests are what the scheduler packs by; limits are what quota bills.
    // CPU requests are a fraction of the limit, so the two diverge and callers
    // pick whichever question they are asking.
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    if (req.cpu) cpuRequestMilli += parseCpu(String(req.cpu));
    if (req.memory) memoryRequestBytes += parseMemory(String(req.memory));
    const cpuLim = lim.cpu ?? req.cpu;
    const memLim = lim.memory ?? req.memory;
    if (cpuLim) cpuLimitMilli += parseCpu(String(cpuLim));
    if (memLim) memoryLimitBytes += parseMemory(String(memLim));
  }
  return {
    nodeName: pod.spec?.nodeName || null,
    namespace: pod.metadata?.namespace || '',
    podName: pod.metadata?.name || '',
    phase: pod.status?.phase ?? null,
    cpuRequestMilli,
    memoryRequestBytes,
    cpuLimitMilli,
    memoryLimitBytes,
    labels: pod.metadata?.labels || {}
  };
}

export interface SnapshotRead {
  staleMs?: number;
}

const usable = <T>(e: Entry<T> | null, opts: SnapshotRead): T | null =>
  e && opts.staleMs && Date.now() - e.at < opts.staleMs ? e.value : null;

// Live pods only. Succeeded/Failed are finished work and bill nothing, and
// dropping them here keeps every caller from re-deciding it.
export async function clusterPods(
  kc: k8s.KubeConfig | null,
  opts: SnapshotRead = {}
): Promise<PodSnapshot[]> {
  if (!kc) return [];
  const stale = usable(podCache, opts);
  if (fresh(podCache)) return podCache.value;
  if (stale) {
    void refreshPods(kc);
    return stale;
  }
  return refreshPods(kc);
}

function refreshPods(kc: k8s.KubeConfig): Promise<PodSnapshot[]> {
  if (podInFlight) return podInFlight;

  podInFlight = (async () => {
    try {
      const api = kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listPodForAllNamespaces();
      const out = (res.body.items ?? [])
        .filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
        .map(projectPod);
      podCache = { at: Date.now(), value: out };
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] cluster pod snapshot failed:', message);
      // Serve a stale snapshot rather than reporting zero usage, which would
      // read as "you have your whole quota free" and let a deploy through.
      return podCache?.value ?? [];
    } finally {
      podInFlight = null;
    }
  })();

  return podInFlight;
}

export async function clusterServiceCounts(
  kc: k8s.KubeConfig | null,
  opts: SnapshotRead = {}
): Promise<Map<string, number>> {
  if (!kc) return new Map();
  const stale = usable(svcCache, opts);
  if (fresh(svcCache)) return svcCache.value;
  if (stale) {
    void refreshServices(kc);
    return stale;
  }
  return refreshServices(kc);
}

function refreshServices(kc: k8s.KubeConfig): Promise<Map<string, number>> {
  if (svcInFlight) return svcInFlight;

  svcInFlight = (async () => {
    try {
      const api = kc.makeApiClient(k8s.CoreV1Api);
      const res = await api.listServiceForAllNamespaces();
      const counts = new Map<string, number>();
      for (const s of res.body.items ?? []) {
        const ns = s.metadata?.namespace;
        if (!ns) continue;
        counts.set(ns, (counts.get(ns) ?? 0) + 1);
      }
      svcCache = { at: Date.now(), value: counts };
      return counts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[K8s] cluster service snapshot failed:', message);
      return svcCache?.value ?? new Map();
    } finally {
      svcInFlight = null;
    }
  })();

  return svcInFlight;
}

// For tests and for anything that has just mutated the cluster and wants the
// next read to reflect it.
export function invalidateClusterSnapshot(): void {
  podCache = null;
  svcCache = null;
}
