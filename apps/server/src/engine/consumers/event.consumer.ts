import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { EngineEventType } from '../core/informer';

export type ClusterEventKind =
  | 'eviction'
  | 'preemption'
  | 'scheduling'
  | 'killing'
  | 'volume'
  | 'node';

export interface ClassifiedEvent {
  key: string;
  kind: ClusterEventKind;
  reason: string;
  namespace: string;
  objectName: string;
  nodeName: string | null;
  message: string | null;
  count: number;
  at: Date;
  lastAt: Date;
}

const REASON_KINDS: Record<string, ClusterEventKind> = {
  Evicted: 'eviction',
  TaintManagerEviction: 'eviction',
  Preempted: 'preemption',
  Preempting: 'preemption',
  FailedScheduling: 'scheduling',
  NodeNotReady: 'node',
  FailedMount: 'volume',
  FailedAttachVolume: 'volume'
};

const PROBE_KILL_RE = /failed (liveness|startup) probe/i;

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function classifyEvent(ev: k8s.CoreV1Event): ClassifiedEvent | null {
  const reason = ev.reason ?? '';
  const message = ev.message ?? null;
  let kind: ClusterEventKind | undefined = REASON_KINDS[reason];
  if (!kind && reason === 'Killing' && message && PROBE_KILL_RE.test(message)) kind = 'killing';
  if (!kind) return null;
  const involved = ev.involvedObject;
  if (involved?.kind !== 'Pod' || !involved.name) return null;
  const namespace = involved.namespace ?? ev.metadata?.namespace;
  const uid = ev.metadata?.uid;
  if (!namespace || !uid) return null;
  const first =
    toDate(ev.firstTimestamp) ??
    toDate(ev.eventTime) ??
    toDate(ev.metadata?.creationTimestamp) ??
    new Date();
  const last =
    toDate(ev.series?.lastObservedTime) ??
    toDate(ev.lastTimestamp) ??
    toDate(ev.eventTime) ??
    first;
  return {
    key: `event:${uid}`,
    kind,
    reason,
    namespace,
    objectName: involved.name,
    nodeName: ev.source?.host ?? ev.reportingInstance ?? null,
    message: message ? message.slice(0, 1000) : null,
    count: Math.max(1, ev.series?.count ?? ev.count ?? 1),
    at: first,
    lastAt: last
  };
}

export function deploymentNameFromPod(podName: string): string | null {
  const parts = podName.split('-');
  if (parts.length >= 3) return parts.slice(0, -2).join('-');
  return null;
}

export function sanitizeEvent(ev: k8s.CoreV1Event): k8s.CoreV1Event {
  return {
    apiVersion: ev.apiVersion,
    kind: ev.kind,
    metadata: {
      name: ev.metadata?.name,
      namespace: ev.metadata?.namespace,
      uid: ev.metadata?.uid,
      resourceVersion: ev.metadata?.resourceVersion,
      creationTimestamp: ev.metadata?.creationTimestamp
    },
    involvedObject: ev.involvedObject,
    reason: ev.reason,
    message: ev.message,
    type: ev.type,
    count: ev.count,
    firstTimestamp: ev.firstTimestamp,
    lastTimestamp: ev.lastTimestamp,
    eventTime: ev.eventTime,
    series: ev.series,
    source: ev.source,
    reportingInstance: ev.reportingInstance
  } as k8s.CoreV1Event;
}

@Injectable()
export class EventConsumer {
  private readonly logger = new Logger(EventConsumer.name);

  constructor(private readonly prisma: PrismaService) {}

  async onEvent(type: EngineEventType, ev: k8s.CoreV1Event): Promise<void> {
    if (type === 'delete') return;
    const classified = classifyEvent(ev);
    if (!classified) return;
    const deploymentId = await this.resolveDeployment(classified.namespace, classified.objectName);
    if (!deploymentId) return;
    await this.prisma.clusterEvent.upsert({
      where: { key: classified.key },
      create: { ...classified, deploymentId },
      update: {
        count: classified.count,
        lastAt: classified.lastAt,
        message: classified.message,
        nodeName: classified.nodeName
      }
    });
  }

  private async resolveDeployment(namespace: string, podName: string): Promise<string | null> {
    const pod = await this.prisma.pod.findFirst({
      where: { name: podName, deployment: { namespace } },
      select: { deploymentId: true }
    });
    if (pod) return pod.deploymentId;
    const name = deploymentNameFromPod(podName);
    if (!name) return null;
    const deployment = await this.prisma.deployment.findFirst({
      where: { namespace, OR: [{ name }, { name: name.replace(/-green$/, '') }] },
      select: { id: true }
    });
    return deployment?.id ?? null;
  }

  async prune(retentionDays: number): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.clusterEvent.deleteMany({ where: { at: { lt: cutoff } } });
    if (count > 0) this.logger.log(`pruned ${count} cluster events older than ${retentionDays}d`);
  }
}
