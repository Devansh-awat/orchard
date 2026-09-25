import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OrgEventsService } from '../events/org-events.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { referencedSharedKeys, resolveEnvVars, EnvVar } from '../env/env-resolver';
import { ResourceBindingsService } from './resource-bindings.service';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Generous ceilings — unreachable in normal use, but bound what a single env can
// store so a client can't bloat the DB or blow past the 1MB k8s Secret limit.
const MAX_VARS = 1000;
const MAX_KEY_LEN = 256;
const MAX_VALUE_BYTES = 64 * 1024;

export interface SharedVarInput {
  key: string;
  // null = keep the currently stored value (secret values are write-only over GET,
  // so read-modify-write clients can't echo them back).
  value: string | null;
  secret?: boolean;
}

@Injectable()
export class EnvironmentSharedVarsService {
  private readonly logger = new Logger(EnvironmentSharedVarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgEvents: OrgEventsService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly crypto: SecretCryptoService,
    private readonly resourceBindings: ResourceBindingsService
  ) {}

  /**
   * Re-inject every deployment in the environment whose resolved env changed
   * between the old and new shared-var sets. Deployments that reference none of
   * the changed keys are left untouched (no rollout storm).
   */
  private async propagateToDeployments(
    environmentId: string,
    before: EnvVar[],
    after: EnvVar[]
  ): Promise<void> {
    const deployments = await this.prisma.deployment.findMany({
      where: { environmentId },
      select: {
        id: true,
        name: true,
        namespace: true,
        envVars: { select: { key: true, value: true, secret: true } }
      }
    });
    await Promise.allSettled(
      deployments.map(async (dep) => {
        // Decrypt secret values before resolution so plaintext flows to k8s.
        // `before`/`after` are already plaintext (see updateSharedVars).
        const own = dep.envVars.map((v) => this.crypto.maybeDecrypt(v));
        const resources = await this.resourceBindings.valuesFor(dep.id);
        const resolvedBefore = resolveEnvVars(own, before, resources).resolved;
        const resolvedAfter = resolveEnvVars(own, after, resources).resolved;
        if (JSON.stringify(resolvedBefore) === JSON.stringify(resolvedAfter)) return;
        const exists = await this.k8sWorkload
          .getKubernetesDeployment(dep.name, dep.namespace)
          .then((d) => d !== null)
          .catch(() => false);
        if (!exists) return;
        await this.k8sWorkload
          .updateDeploymentEnv({
            namespace: dep.namespace,
            deploymentName: dep.name,
            env: resolvedAfter
          })
          .catch((e) => this.logger.warn(`re-inject ${dep.name} failed: ${e?.message}`));
      })
    );
  }

  private async envOrThrow(environmentId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: { select: { id: true, organizationId: true } } }
    });
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  async getSharedVars(environmentId: string, canEdit: boolean) {
    await this.envOrThrow(environmentId);
    const vars = await this.prisma.environmentSharedVar.findMany({
      where: { environmentId },
      orderBy: { key: 'asc' },
      select: { key: true, value: true, secret: true }
    });
    // Viewers never see values; secret values are additionally never returned.
    return vars.map((v) => ({
      key: v.key,
      secret: v.secret,
      value: !canEdit || v.secret ? null : v.value
    }));
  }

  async updateSharedVars(environmentId: string, input: SharedVarInput[], userId: string) {
    const env = await this.envOrThrow(environmentId);

    // Decrypt secret values from the current set so change-detection and
    // rollout propagation compare plaintext against plaintext.
    const before = (
      await this.prisma.environmentSharedVar.findMany({
        where: { environmentId },
        select: { key: true, value: true, secret: true }
      })
    ).map((v) => this.crypto.maybeDecrypt(v));
    const beforeMap = new Map(before.map((v) => [v.key, v]));

    // PUT is full-replace but secret values are write-only (GET returns null),
    // so a read-modify-write client can never echo them back. The keep rules:
    // value === null keeps the stored value for an existing key, and value === ''
    // keeps it when the row is secret both before and after (the web editor shows
    // untouched secrets as blank). Un-marking a secret without a value is rejected
    // rather than silently publishing the plaintext. New keys with null/empty
    // values are stored empty, as before.
    const seen = new Map<string, { key: string; value: string; secret: boolean }>();
    for (const raw of Array.isArray(input) ? input : []) {
      const key = String(raw?.key ?? '').trim();
      if (!key) continue;
      if (key.length > MAX_KEY_LEN) {
        throw new BadRequestException(`Environment variable key too long: ${key.slice(0, 32)}…`);
      }
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
      const secret = Boolean(raw.secret);
      const existing = beforeMap.get(key);
      let value: string;
      if (raw.value == null) {
        if (existing?.secret && !secret) {
          throw new BadRequestException(
            `Cannot un-mark ${key} as secret without providing a value`
          );
        }
        value = existing ? existing.value : '';
      } else {
        value = String(raw.value);
        if (value === '' && secret && existing?.secret) value = existing.value;
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        throw new BadRequestException(`Value for ${key} exceeds ${MAX_VALUE_BYTES / 1024}KB`);
      }
      seen.set(key, { key, value, secret });
    }
    if (seen.size > MAX_VARS) {
      throw new BadRequestException(`Too many variables (max ${MAX_VARS})`);
    }
    const vars = Array.from(seen.values());

    await this.prisma.$transaction(async (tx) => {
      await tx.environmentSharedVar.deleteMany({ where: { environmentId } });
      if (vars.length > 0) {
        await tx.environmentSharedVar.createMany({
          data: vars.map((v) => ({
            environmentId,
            key: v.key,
            value: this.crypto.encryptIfSecret(v.value, v.secret),
            secret: v.secret
          }))
        });
      }
    });

    // Restart deployments whose resolved env actually changed.
    void this.propagateToDeployments(
      environmentId,
      before.map((v) => ({ key: v.key, value: v.value, secret: v.secret })),
      vars.map((v) => ({ key: v.key, value: v.value, secret: v.secret }))
    ).catch((e) => this.logger.warn(`shared-var propagation failed: ${e?.message}`));

    // Save-time reference validation → warnings, not errors (don't force
    // insertion order; a user may reference a key they're about to add).
    const definedKeys = new Set(vars.map((v) => v.key));
    const warnings: { key: string; missingRef: string }[] = [];
    for (const v of vars) {
      for (const ref of referencedSharedKeys([v])) {
        if (!definedKeys.has(ref)) warnings.push({ key: v.key, missingRef: ref });
      }
    }

    const added = vars.filter((v) => !beforeMap.has(v.key)).map((v) => v.key);
    const removed = before.filter((v) => !seen.has(v.key)).map((v) => v.key);
    const changed = vars
      .filter((v) => beforeMap.has(v.key) && beforeMap.get(v.key)!.value !== v.value)
      .map((v) => v.key);

    void this.audit.log({
      action: 'environment.sharedvars.updated',
      actorUserId: userId,
      organizationId: env.project.organizationId,
      projectId: env.project.id,
      targetType: 'environment',
      targetId: env.id,
      targetLabel: env.name,
      metadata: {
        added: added.join(',') || null,
        removed: removed.join(',') || null,
        changed: changed.join(',') || null
      }
    });

    this.orgEvents.emit({
      organizationId: env.project.organizationId,
      type: 'sharedvars.changed',
      id: env.id,
      projectId: env.project.id
    });

    return { vars: await this.getSharedVars(environmentId, true), warnings };
  }
}
