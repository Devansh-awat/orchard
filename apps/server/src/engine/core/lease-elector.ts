import { EventEmitter } from 'events';
import * as k8s from '@kubernetes/client-node';
import { consoleLogger, EngineLogger } from './logger';

export interface LeaseElectorOptions {
  namespace: string;
  name: string;
  identity: string;
  leaseDurationSeconds?: number;
  renewIntervalMs?: number;
  shouldAcquire?: () => boolean;
  logger?: EngineLogger;
}

export interface Elector {
  isHolder(): boolean;
  start(): void;
  stop(): Promise<void>;
  resign(): Promise<void>;
  on(event: 'acquired' | 'lost', listener: () => void): this;
}

export class StaticElector extends EventEmitter implements Elector {
  constructor(private readonly holder: boolean) {
    super();
  }

  isHolder(): boolean {
    return this.holder;
  }

  start(): void {
    if (this.holder) setImmediate(() => this.emit('acquired'));
  }

  async stop(): Promise<void> {
    this.removeAllListeners();
  }

  async resign(): Promise<void> {
    return undefined;
  }
}

export class LeaseElector extends EventEmitter implements Elector {
  private readonly logger: EngineLogger;

  private readonly api: k8s.CoordinationV1Api;

  private readonly namespace: string;

  private readonly name: string;

  private readonly identity: string;

  private readonly leaseDurationSeconds: number;

  private readonly renewIntervalMs: number;

  private readonly shouldAcquire?: () => boolean;

  private timer?: ReturnType<typeof setInterval>;

  private holding = false;

  private validUntil = 0;

  private held?: k8s.V1Lease;

  private renewFailures = 0;

  private stopped = true;

  constructor(kc: k8s.KubeConfig, opts: LeaseElectorOptions) {
    super();
    this.api = kc.makeApiClient(k8s.CoordinationV1Api);
    this.namespace = opts.namespace;
    this.name = opts.name;
    this.identity = opts.identity;
    this.leaseDurationSeconds = opts.leaseDurationSeconds ?? 30;
    this.renewIntervalMs = opts.renewIntervalMs ?? 10_000;
    this.shouldAcquire = opts.shouldAcquire;
    this.logger = opts.logger ?? consoleLogger(`LeaseElector:${opts.name}`);
  }

  isHolder(): boolean {
    this.dropIfStale();
    return this.holding;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.renewIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.holding) {
      await this.release();
      this.setHolding(false);
    }
  }

  async resign(): Promise<void> {
    if (!this.holding) return;
    await this.release();
    this.setHolding(false);
  }

  private async release(): Promise<void> {
    this.held = undefined;
    try {
      const { body: lease } = await this.api.readNamespacedLease(this.name, this.namespace);
      if (lease.spec?.holderIdentity !== this.identity) return;
      lease.spec.holderIdentity = '';
      lease.spec.renewTime = new k8s.V1MicroTime();
      await this.api.replaceNamespacedLease(this.name, this.namespace, lease);
      this.logger.log(`released lease (${this.identity})`);
    } catch (error) {
      this.logger.warn(`lease release failed: ${(error as Error).message}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.dropIfStale();
    const started = Date.now();
    if (this.holding && this.held && (await this.renewHeld(started))) return;
    try {
      const lease = await this.readLease();
      if (this.stopped) return;
      if (!lease) {
        if (this.shouldAcquire && !this.shouldAcquire()) {
          this.setHolding(false);
          return;
        }
        await this.createLease();
        this.onRenewed(true, started);
        return;
      }
      const holder = lease.spec?.holderIdentity;
      if (holder === this.identity) {
        lease.spec!.renewTime = new k8s.V1MicroTime();
        lease.spec!.leaseDurationSeconds = this.leaseDurationSeconds;
        await this.replace(lease);
        this.onRenewed(false, started);
        return;
      }
      if (!holder || this.isExpired(lease)) {
        if (this.shouldAcquire && !this.shouldAcquire()) {
          this.setHolding(false);
          return;
        }
        lease.spec = {
          holderIdentity: this.identity,
          leaseDurationSeconds: this.leaseDurationSeconds,
          acquireTime: new k8s.V1MicroTime(),
          renewTime: new k8s.V1MicroTime(),
          leaseTransitions: (lease.spec?.leaseTransitions ?? 0) + 1
        };
        await this.replace(lease);
        this.onRenewed(true, started);
        return;
      }
      this.renewFailures = 0;
      this.setHolding(false);
    } catch (error) {
      const status = (error as { response?: { statusCode?: number } }).response?.statusCode;
      if (status === 409) {
        this.renewFailures = 0;
        this.setHolding(false);
        return;
      }
      this.renewFailures += 1;
      this.logger.warn(`lease tick failed (${this.renewFailures}): ${(error as Error).message}`);
      if (this.holding && this.renewFailures >= 2) this.setHolding(false);
    }
  }

  private async renewHeld(started: number): Promise<boolean> {
    const lease = this.held!;
    lease.spec!.renewTime = new k8s.V1MicroTime();
    try {
      await this.replace(lease);
      this.onRenewed(false, started);
      return true;
    } catch {
      this.held = undefined;
      return false;
    }
  }

  private async replace(lease: k8s.V1Lease): Promise<void> {
    const { body } = await this.api.replaceNamespacedLease(this.name, this.namespace, lease);
    this.held = body;
  }

  private async readLease(): Promise<k8s.V1Lease | null> {
    try {
      const { body } = await this.api.readNamespacedLease(this.name, this.namespace);
      return body;
    } catch (error) {
      if ((error as { response?: { statusCode?: number } }).response?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private async createLease(): Promise<void> {
    const { body } = await this.api.createNamespacedLease(this.namespace, {
      metadata: { name: this.name, namespace: this.namespace },
      spec: {
        holderIdentity: this.identity,
        leaseDurationSeconds: this.leaseDurationSeconds,
        acquireTime: new k8s.V1MicroTime(),
        renewTime: new k8s.V1MicroTime(),
        leaseTransitions: 0
      }
    });
    this.held = body;
  }

  private isExpired(lease: k8s.V1Lease): boolean {
    const renewTime = lease.spec?.renewTime;
    if (!renewTime) return true;
    const ageMs = Date.now() - new Date(renewTime).getTime();
    return ageMs > (lease.spec?.leaseDurationSeconds ?? this.leaseDurationSeconds) * 1000;
  }

  private dropIfStale(): void {
    if (this.holding && Date.now() >= this.validUntil) this.setHolding(false);
  }

  private onRenewed(acquired: boolean, started: number): void {
    if (this.stopped) {
      void this.release();
      return;
    }
    this.renewFailures = 0;
    const window = this.leaseDurationSeconds * 1000;
    this.validUntil = started + Math.max(window / 2, window - this.renewIntervalMs);
    if (acquired && !this.holding) {
      this.logger.log(`acquired lease (${this.identity})`);
    }
    this.setHolding(true);
  }

  private setHolding(value: boolean): void {
    if (!value) this.held = undefined;
    if (this.holding === value) return;
    this.holding = value;
    if (!value) this.logger.log('lost lease');
    this.emit(value ? 'acquired' : 'lost');
  }
}
