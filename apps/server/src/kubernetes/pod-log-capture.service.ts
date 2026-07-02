import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import Redis from 'ioredis';
import { K8sWorkloadService } from './k8s-workload.service';

const TTL_MS = 24 * 60 * 60 * 1000;
const INDEX_MAX = 50;
const TAIL_LINES = 500;

export interface KilledContainerMeta {
  entryId: string;
  pod: string;
  container: string;
  reason: string;
  exitCode: number | null;
  finishedAt: string | null;
  capturedAt: string;
}

interface KilledEntry extends KilledContainerMeta {
  logs: string;
}

@Injectable()
export class PodLogCaptureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PodLogCaptureService.name);
  private redis: Redis | null = null;

  constructor(private readonly k8sWorkload: K8sWorkloadService) {}

  onModuleInit() {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn('REDIS_URL not set — killed-container log capture disabled');
      return;
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    this.redis.on('error', (e) => this.logger.warn(`capture redis error: ${e.message}`));
  }

  onModuleDestroy() {
    try {
      this.redis?.disconnect();
    } catch {}
  }

  private idxKey(deploymentId: string) {
    return `orchard:killed:idx:${deploymentId}`;
  }
  private entryKey(deploymentId: string, entryId: string) {
    return `orchard:killed:entry:${deploymentId}:${entryId}`;
  }
  private seenKey(deploymentId: string, entryId: string) {
    return `orchard:killed:seen:${deploymentId}:${entryId}`;
  }

  async capture(deploymentId: string, namespace: string, pod: k8s.V1Pod) {
    if (!this.redis) return;
    const podName = pod.metadata?.name;
    if (!podName) return;

    for (const cs of pod.status?.containerStatuses ?? []) {
      const currentTerm = cs.state?.terminated;
      const prevTerm = cs.lastState?.terminated;
      const term = currentTerm ?? prevTerm;
      if (!term?.reason || term.reason === 'Completed') continue;

      const finishedAt = term.finishedAt ? new Date(term.finishedAt) : null;
      const finishedMs = finishedAt ? finishedAt.getTime() : 0;
      const entryId = `${podName}__${cs.name}__${finishedMs}`;

      try {
        const claimed = await this.redis.set(
          this.seenKey(deploymentId, entryId),
          '1',
          'PX',
          TTL_MS,
          'NX',
        );
        if (!claimed) continue;

        const usePrevious = !currentTerm;
        let logs = '';
        try {
          const res = await this.k8sWorkload.getPodLogs(
            podName,
            namespace,
            cs.name,
            TAIL_LINES,
            usePrevious,
          );
          logs = res?.logs ?? '';
        } catch (e) {
          this.logger.warn(
            `capture log fetch failed for ${podName}/${cs.name}: ${(e as Error).message}`,
          );
        }

        const entry: KilledEntry = {
          entryId,
          pod: podName,
          container: cs.name,
          reason: term.reason,
          exitCode: term.exitCode ?? null,
          finishedAt: finishedAt ? finishedAt.toISOString() : null,
          capturedAt: new Date(finishedMs || Date.now()).toISOString(),
          logs,
        };

        await this.redis.set(
          this.entryKey(deploymentId, entryId),
          JSON.stringify(entry),
          'PX',
          TTL_MS,
        );
        await this.redis.lpush(this.idxKey(deploymentId), entryId);
        await this.redis.ltrim(this.idxKey(deploymentId), 0, INDEX_MAX - 1);
        await this.redis.pexpire(this.idxKey(deploymentId), TTL_MS);
      } catch (e) {
        this.logger.warn(`capture failed for ${podName}/${cs.name}: ${(e as Error).message}`);
      }
    }
  }

  async list(deploymentId: string): Promise<KilledContainerMeta[]> {
    if (!this.redis) return [];
    const ids = await this.redis.lrange(this.idxKey(deploymentId), 0, INDEX_MAX - 1);
    if (ids.length === 0) return [];
    const keys = ids.map((id) => this.entryKey(deploymentId, id));
    const rows = await this.redis.mget(keys);
    const out: KilledContainerMeta[] = [];
    for (const row of rows) {
      if (!row) continue;
      try {
        const e = JSON.parse(row) as KilledEntry;
        out.push({
          entryId: e.entryId,
          pod: e.pod,
          container: e.container,
          reason: e.reason,
          exitCode: e.exitCode,
          finishedAt: e.finishedAt,
          capturedAt: e.capturedAt,
        });
      } catch {}
    }
    return out;
  }

  async getLogs(deploymentId: string, entryId: string): Promise<KilledEntry | null> {
    if (!this.redis) return null;
    const row = await this.redis.get(this.entryKey(deploymentId, entryId));
    if (!row) return null;
    try {
      return JSON.parse(row) as KilledEntry;
    } catch {
      return null;
    }
  }
}
