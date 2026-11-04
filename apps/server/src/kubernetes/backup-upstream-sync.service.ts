import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { LeaseService } from '../coordination/lease.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { BackupTarget, currentProxyTarget } from '../instance-config/object-storage';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { r2ProxyNamespace } from './security-policies';

export const STORED_UPSTREAM_SECRET = 'r2-proxy-stored';
export const STORED_UPSTREAM_FILE = 'upstreams.json';
const HISTORY_SETTING = 'object_storage_backup_targets';
const REWRITE_EVERY_MS = 10 * 60 * 1000;

export interface ProxyTarget {
  bucket: string;
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

export function mergeProxyTargets(
  history: ProxyTarget[],
  current: BackupTarget | null
): ProxyTarget[] {
  if (!current) return history;
  const next: ProxyTarget = {
    bucket: current.bucket,
    endpoint: current.endpoint,
    region: current.region,
    accessKey: current.accessKey,
    secretKey: current.secretKey,
    pathStyle: current.pathStyle
  };
  return [...history.filter((t) => t.bucket !== next.bucket), next];
}

export function proxyUpstreamDocument(
  targets: ProxyTarget[],
  current: BackupTarget | null
): string | null {
  if (!targets.length) return null;
  return JSON.stringify({ defaultBucket: current?.bucket ?? '', targets });
}

@Injectable()
export class BackupUpstreamSyncService {
  private readonly logger = new Logger(BackupUpstreamSyncService.name);

  private lastDigest: string | null = null;

  private lastWrite = 0;

  private running = false;

  constructor(private readonly moduleRef: ModuleRef) {}

  private canWrite(): boolean {
    if (process.env.BACKUP_PROXY_ENABLED !== 'true') return false;
    try {
      const lease = this.moduleRef.get(LeaseService, { strict: false });
      const leader = this.moduleRef.get(LeaderElectionService, { strict: false });
      return !!lease?.canCoordinate && !!leader?.isLeader();
    } catch {
      return false;
    }
  }

  private async readHistory(): Promise<ProxyTarget[]> {
    const settings = this.moduleRef.get(InstanceSettingsService, { strict: false });
    const crypto = this.moduleRef.get(SecretCryptoService, { strict: false });
    const raw = await settings.get(HISTORY_SETTING);
    if (!raw) return [];
    return JSON.parse(crypto.decrypt(raw)) as ProxyTarget[];
  }

  private async writeHistory(targets: ProxyTarget[]): Promise<void> {
    const settings = this.moduleRef.get(InstanceSettingsService, { strict: false });
    const crypto = this.moduleRef.get(SecretCryptoService, { strict: false });
    await settings.set(HISTORY_SETTING, crypto.encrypt(JSON.stringify(targets)));
  }

  @Interval(30_000)
  async tick(): Promise<void> {
    if (this.running || !this.canWrite()) return;
    this.running = true;
    try {
      await this.sync();
    } catch (e: any) {
      this.logger.warn(`couldn't update the backup proxy: ${e?.name ?? 'error'}`);
    } finally {
      this.running = false;
    }
  }

  async sync(): Promise<void> {
    const current = currentProxyTarget();
    const history = await this.readHistory();
    const targets = mergeProxyTargets(history, current);
    const document = proxyUpstreamDocument(targets, current);
    if (!document) return;
    const digest = createHash('sha256').update(document).digest('hex');
    if (digest === this.lastDigest && Date.now() - this.lastWrite < REWRITE_EVERY_MS) return;
    if (JSON.stringify(targets) !== JSON.stringify(history)) await this.writeHistory(targets);
    const k8sCnpg = this.moduleRef.get(K8sCnpgService, { strict: false });
    await k8sCnpg.writeSecret(r2ProxyNamespace(), STORED_UPSTREAM_SECRET, {
      [STORED_UPSTREAM_FILE]: document
    });
    if (digest !== this.lastDigest) {
      this.logger.log(`backup proxy now serves ${targets.length} stored bucket(s)`);
    }
    this.lastDigest = digest;
    this.lastWrite = Date.now();
  }
}
