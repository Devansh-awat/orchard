import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { AuditService } from '../../audit/audit.service';
import { EngineEventType, EngineObjectKey } from '../core/informer';
import { GuardKind, GuardManifest, fingerprint, missingLabels, specDrift } from '../guard/compare';
import { GuardCluster, GuardKey, K8sGuardCluster, statusOf } from '../guard/cluster';
import { DesiredObject, GuardDesired, PrismaGuardDesired } from '../guard/desired';
import { RestoreLimiter } from '../guard/restore-limiter';

export const GUARD_REASON = 'enforced by orchard';
export const GUARD_AUDIT_ACTION = 'security.policy.restored';

const SETTLE_MS = 10_000;
const CONFLICT_RETRY_MS = 5_000;

type Outcome = 'ok' | 'pending';

interface Verdict {
  ok: boolean;
  specChanges: string[];
  labelChanges: string[];
}

export class RestorePending extends Error {}

function idOf(key: GuardKey): string {
  return `${key.kind}/${key.namespace}/${key.name}`;
}

@Injectable()
export class GuardConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(GuardConsumer.name);

  protected desired: GuardDesired;

  protected cluster: GuardCluster;

  protected limiter = new RestoreLimiter();

  protected settleMs = SETTLE_MS;

  protected now: () => number = () => Date.now();

  private readonly firstDrift = new Map<string, number>();

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly chains = new Map<string, Promise<Outcome>>();

  private readonly accepted = new Map<string, { desired: string; live: string }>();

  private readonly hints = new Map<string, GuardManifest>();

  constructor(
    prisma: PrismaService,
    kubernetes: KubernetesService,
    private readonly audit: AuditService
  ) {
    this.cluster = new K8sGuardCluster(kubernetes);
    this.desired = new PrismaGuardDesired(
      prisma,
      () => kubernetes.isCiliumAvailable(),
      this.cluster,
      () => kubernetes.apiserverEndpoints()
    );
  }

  onModuleDestroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async onEvent(kind: GuardKind, type: EngineEventType, obj: GuardManifest): Promise<void> {
    const namespace = obj?.metadata?.namespace;
    const name = obj?.metadata?.name;
    if (!namespace || !name) return;
    const key: GuardKey = { kind, namespace, name };
    if (type !== 'delete') {
      const want = await this.desired.desired(key, obj);
      if (!want || this.verdict(key, want, obj).ok) {
        this.settled(key);
        return;
      }
    }
    const outcome = await this.enforce(key, obj);
    if (outcome === 'pending') {
      throw new RestorePending(
        `${kind} ${namespace}/${name} differs from what orchard enforces; restore pending`
      );
    }
  }

  async sweep(kind: GuardKind, seen: EngineObjectKey[]): Promise<void> {
    const live = new Set(seen.map((key) => `${key.namespace}/${key.name}`));
    const expected = await this.desired.expected(kind);
    for (const key of expected) {
      if (live.has(`${key.namespace}/${key.name}`)) continue;
      await this.enforce(key, null).catch((err) =>
        this.logger.warn(`could not check ${idOf(key)}: ${(err as Error)?.message ?? err}`)
      );
    }
  }

  enforce(key: GuardKey, hint: GuardManifest | null): Promise<Outcome> {
    const id = idOf(key);
    const prev = this.chains.get(id) ?? Promise.resolve<Outcome>('ok');
    const next = prev.then(
      () => this.runEnforce(key, hint),
      () => this.runEnforce(key, hint)
    );
    this.chains.set(id, next);
    const clear = () => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    };
    next.then(clear, clear);
    return next;
  }

  private async runEnforce(key: GuardKey, hint: GuardManifest | null): Promise<Outcome> {
    const id = idOf(key);
    if (hint) this.hints.set(id, hint);
    const want = await this.desired.desired(key, hint ?? this.hints.get(id) ?? null);
    if (!want) {
      this.settled(key);
      return 'ok';
    }
    if (!(await this.cluster.namespaceActive(key.namespace))) {
      this.settled(key);
      return 'ok';
    }
    const live = await this.cluster.read(key);
    const verdict: Verdict =
      live.state === 'present'
        ? this.verdict(key, want, live.obj)
        : { ok: false, specChanges: ['deleted'], labelChanges: [] };
    if (verdict.ok) {
      this.settled(key);
      return 'ok';
    }

    const now = this.now();
    const first = this.firstDrift.get(id) ?? now;
    this.firstDrift.set(id, first);
    if (now - first < this.settleMs) {
      this.schedule(key, first + this.settleMs - now);
      return 'pending';
    }

    const gate = this.limiter.check(id);
    if (!gate.allowed) {
      if (gate.backingOff) {
        this.logger.error(
          `${id} keeps being changed away from what orchard enforces; backing off, next restore at ${new Date(gate.retryAt).toISOString()}`
        );
      }
      this.schedule(key, gate.retryAt - now);
      return 'pending';
    }

    let written: GuardManifest;
    try {
      written =
        live.state === 'present'
          ? await this.cluster.replace(key, {
              ...want.manifest,
              metadata: {
                ...want.manifest.metadata,
                resourceVersion: live.obj.metadata?.resourceVersion
              }
            })
          : await this.cluster.create(key, want.manifest);
    } catch (err) {
      const code = statusOf(err);
      if (code === 409 || code === 404) {
        this.schedule(key, CONFLICT_RETRY_MS);
        return 'pending';
      }
      throw err;
    }

    this.firstDrift.delete(id);
    const state = this.limiter.record(id);
    this.rememberNormalisation(key, want.manifest, written);

    const deleted = live.state === 'absent';
    if (verdict.specChanges.length === 0) {
      this.logger.log(
        `relabelled ${id} (${verdict.labelChanges.join(', ')}) so the guard keeps watching it`
      );
    } else {
      this.logger.warn(
        `restored ${id} (${deleted ? 'deleted' : verdict.specChanges.join(', ')}): ${GUARD_REASON}`
      );
      void this.audit.log({
        action: GUARD_AUDIT_ACTION,
        organizationId: want.scope.organizationId,
        projectId: want.scope.projectId,
        targetType: 'security_policy',
        targetLabel: `${key.kind} ${key.namespace}/${key.name}`,
        metadata: {
          kind: key.kind,
          namespace: key.namespace,
          name: key.name,
          change: deleted ? 'deleted' : 'modified',
          changed: deleted ? ['deleted'] : [...verdict.specChanges, ...verdict.labelChanges],
          reason: GUARD_REASON
        }
      });
    }
    if (state.backingOff) {
      this.logger.error(
        `${id} has been restored ${state.restores} times in the last hour; something keeps changing it. Backing off until ${new Date(state.nextAllowedAt).toISOString()}`
      );
    }
    return 'ok';
  }

  private verdict(key: GuardKey, want: DesiredObject, live: GuardManifest): Verdict {
    const id = idOf(key);
    let specChanges = specDrift(key.kind, want.manifest.spec, live.spec);
    if (specChanges.length > 0) {
      const known = this.accepted.get(id);
      if (
        known &&
        known.desired === fingerprint(key.kind, want.manifest.spec) &&
        known.live === fingerprint(key.kind, live.spec)
      ) {
        specChanges = [];
      }
    }
    const labelChanges = missingLabels(want.manifest.metadata?.labels, live.metadata?.labels).map(
      (label) => `metadata.labels.${label}`
    );
    return {
      ok: specChanges.length === 0 && labelChanges.length === 0,
      specChanges,
      labelChanges
    };
  }

  private rememberNormalisation(key: GuardKey, desired: GuardManifest, written: GuardManifest) {
    const id = idOf(key);
    const drift = specDrift(key.kind, desired.spec, written.spec);
    if (drift.length === 0) {
      this.accepted.delete(id);
      return;
    }
    this.accepted.set(id, {
      desired: fingerprint(key.kind, desired.spec),
      live: fingerprint(key.kind, written.spec)
    });
    this.logger.warn(
      `the apiserver stores ${id} differently from what orchard sends (${drift.join(', ')}); accepting its form`
    );
  }

  private schedule(key: GuardKey, delayMs: number) {
    const id = idOf(key);
    if (this.timers.has(id)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(id);
        void this.enforce(key, null).catch((err) =>
          this.logger.warn(`restore of ${id} failed: ${(err as Error)?.message ?? err}`)
        );
      },
      Math.max(0, delayMs) + 50
    );
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private settled(key: GuardKey) {
    const id = idOf(key);
    this.firstDrift.delete(id);
    this.hints.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
