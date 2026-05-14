import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as crypto from 'crypto';
import { KubernetesService } from './kubernetes.service';

export interface R2ProxyBinding {
  accessKey: string;
  secret: string;
  bucket: string;
  prefix: string;
}

interface PolicyFile {
  bindings: R2ProxyBinding[];
}

@Injectable()
export class R2ProxyService {
  private readonly logger = new Logger(R2ProxyService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

  isEnabled(): boolean {
    return process.env.BACKUP_PROXY_ENABLED === 'true';
  }

  getEndpoint(): string {
    const endpoint = (process.env.BACKUP_PROXY_ENDPOINT || '').trim();
    if (this.isEnabled() && !endpoint) {
      throw new InternalServerErrorException(
        'BACKUP_PROXY_ENABLED=true but BACKUP_PROXY_ENDPOINT is not set',
      );
    }
    return endpoint;
  }

  private getNamespace(): string {
    const ns = (process.env.BACKUP_PROXY_NAMESPACE || '').trim();
    if (!ns) {
      throw new InternalServerErrorException(
        'BACKUP_PROXY_NAMESPACE is not configured',
      );
    }
    return ns;
  }

  private getConfigMapName(): string {
    const name = (process.env.BACKUP_PROXY_CONFIGMAP || '').trim();
    if (!name) {
      throw new InternalServerErrorException(
        'BACKUP_PROXY_CONFIGMAP is not configured',
      );
    }
    return name;
  }

  /**
   * Mint a fresh per-cluster fake AK/SK pair that the cluster will hand to
   * barman. The proxy translates these to real R2 credentials.
   */
  mintCredentials(): { accessKey: string; secret: string } {
    const accessKey = `orch-${crypto.randomBytes(8).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    return { accessKey, secret };
  }

  /**
   * Add (or replace by accessKey) a binding in the shared r2-proxy policy
   * ConfigMap. The proxy hot-reloads every 5s.
   */
  async addBinding(opts: R2ProxyBinding): Promise<void> {
    await this.mutatePolicy((bindings) => {
      const filtered = bindings.filter((b) => b.accessKey !== opts.accessKey);
      filtered.push({
        accessKey: opts.accessKey,
        secret: opts.secret,
        bucket: opts.bucket,
        prefix: opts.prefix,
      });
      return filtered;
    });
  }

  /**
   * Remove a binding by accessKey. Idempotent — a no-op if the key is not
   * present.
   */
  async removeBinding(accessKey: string): Promise<void> {
    await this.mutatePolicy((bindings) =>
      bindings.filter((b) => b.accessKey !== accessKey),
    );
  }

  private async mutatePolicy(
    mutate: (bindings: R2ProxyBinding[]) => R2ProxyBinding[],
  ): Promise<void> {
    const coreApi = this.kubernetes.getCoreV1Api();
    const namespace = this.getNamespace();
    const cmName = this.getConfigMapName();

    const read = await coreApi.readNamespacedConfigMap(cmName, namespace);
    const cm = read.body;
    const raw = cm.data?.['policy.json'] || '{"bindings":[]}';

    let parsed: PolicyFile;
    try {
      parsed = JSON.parse(raw) as PolicyFile;
      if (!parsed || !Array.isArray(parsed.bindings)) {
        parsed = { bindings: [] };
      }
    } catch (e: any) {
      this.logger.warn(
        `[R2Proxy] policy.json was invalid JSON, rebuilding: ${e?.message}`,
      );
      parsed = { bindings: [] };
    }

    const nextBindings = mutate(parsed.bindings);
    const nextPolicy: PolicyFile = { bindings: nextBindings };

    const nextData = { ...(cm.data || {}), 'policy.json': JSON.stringify(nextPolicy, null, 2) };

    await coreApi.replaceNamespacedConfigMap(cmName, namespace, {
      metadata: {
        name: cmName,
        namespace,
        labels: cm.metadata?.labels,
        annotations: cm.metadata?.annotations,
        resourceVersion: cm.metadata?.resourceVersion,
      },
      data: nextData,
    });
  }
}
