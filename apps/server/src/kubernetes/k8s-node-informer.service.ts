import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from './kubernetes.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NodesService } from '../nodes/nodes.service';
import { mapNodeToRow } from '../nodes/node-mapping';

const NODE_REMOVE_AFTER_MS = 30 * 60_000;

// Watches cluster nodes and mirrors their labels/taints/schedulable/capacity
// into the `nodes` table, so all reads hit the DB instead of the kube-apiserver
// (the "cache the kubeapi" path). Mirrors K8sPodInformerService: single-flight
// watch with capped backoff, DB writes gated on the Redis leader lock so N
// replicas don't each re-upsert every event.
@Injectable()
export class K8sNodeInformerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(K8sNodeInformerService.name);

  private informer?: k8s.Informer<k8s.V1Node> & k8s.ObjectCache<k8s.V1Node>;

  private backoffMs = 1000;

  private stopped = false;

  private restartTimer?: ReturnType<typeof setTimeout>;

  private readonly pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();

  protected removeAfterMs = NODE_REMOVE_AFTER_MS;

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly leader: LeaderElectionService,
    private readonly nodes: NodesService
  ) {}

  async onModuleInit() {
    const kc = this.kubernetes.kc;
    if (!kc) {
      this.logger.warn('No kubeconfig; node informer disabled');
      return;
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const listFn = () => coreApi.listNode();

    this.informer = k8s.makeInformer(kc, '/api/v1/nodes', listFn);
    this.informer.on('add', (n) => this.onNodeEvent('add', n));
    this.informer.on('update', (n) => this.onNodeEvent('update', n));
    this.informer.on('delete', (n) => this.onNodeEvent('delete', n));
    this.informer.on('connect', () => {
      this.backoffMs = 1000;
    });
    this.informer.on('error', (err) => {
      this.logger.warn(
        `node informer error: ${(err as Error)?.message ?? err}; restarting in ${this.backoffMs}ms`
      );
      this.scheduleRestart();
    });
    await this.start();
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const timer of this.pendingRemovals.values()) clearTimeout(timer);
    this.pendingRemovals.clear();
    try {
      await this.informer?.stop();
    } catch {}
  }

  private async start() {
    if (this.stopped || !this.informer) return;
    try {
      await this.informer.start();
      this.logger.log('node informer started');
    } catch (err) {
      this.logger.warn(`node informer start failed: ${(err as Error)?.message ?? err}`);
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, delay);
  }

  private async onNodeEvent(type: 'add' | 'update' | 'delete', node: k8s.V1Node) {
    if (!this.leader.isLeader()) return;
    const name = node.metadata?.name;
    if (!name) return;
    try {
      if (type === 'delete') {
        this.scheduleRemoval(name);
        return;
      }
      this.cancelRemoval(name);
      await this.nodes.upsertNodeRow(mapNodeToRow(node));
    } catch (err) {
      this.logger.warn(`node ${type} sync failed for ${name}: ${(err as Error)?.message ?? err}`);
    }
  }

  private scheduleRemoval(name: string) {
    if (this.pendingRemovals.has(name)) return;
    this.logger.warn(
      `node ${name} left the cluster; its row and org assignments are kept for ${Math.round(this.removeAfterMs / 60000)} minutes in case it re-registers`
    );
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(name);
      void this.removeIfStillGone(name);
    }, this.removeAfterMs);
    timer.unref?.();
    this.pendingRemovals.set(name, timer);
  }

  private cancelRemoval(name: string) {
    const timer = this.pendingRemovals.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingRemovals.delete(name);
    this.logger.log(`node ${name} came back; keeping its row and org assignments`);
  }

  protected async liveNode(name: string): Promise<'present' | 'absent' | 'unknown'> {
    try {
      await this.kubernetes.kc!.makeApiClient(k8s.CoreV1Api).readNode(name);
      return 'present';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      return code === 404 ? 'absent' : 'unknown';
    }
  }

  private async removeIfStillGone(name: string) {
    if (this.stopped || !this.leader.isLeader()) return;
    const state = await this.liveNode(name);
    if (state === 'present') return;
    if (state === 'unknown') {
      this.scheduleRemoval(name);
      return;
    }
    try {
      await this.nodes.removeNodeByName(name);
      this.logger.warn(`node ${name} has been gone from the cluster for a while; removed its row`);
    } catch (err) {
      this.logger.warn(`removing node ${name} failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
