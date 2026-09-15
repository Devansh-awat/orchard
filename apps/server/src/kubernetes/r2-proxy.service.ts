import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Per-cluster fake R2 credentials. Persisted on the Database row; the proxy
 * looks them up directly from Postgres so there's no out-of-band ConfigMap
 * to drift from the source of truth.
 */
export interface R2ProxyBinding {
  accessKey: string;
  secret: string;
  bucket: string;
  prefix: string;
}

@Injectable()
export class R2ProxyService {
  private readonly logger = new Logger(R2ProxyService.name);

  isEnabled(): boolean {
    return process.env.BACKUP_PROXY_ENABLED === 'true';
  }

  getEndpoint(): string {
    const endpoint = (process.env.BACKUP_PROXY_ENDPOINT || '').trim();
    if (this.isEnabled() && !endpoint) {
      throw new InternalServerErrorException(
        'BACKUP_PROXY_ENABLED=true but BACKUP_PROXY_ENDPOINT is not set'
      );
    }
    return endpoint;
  }

  /**
   * Mint a fresh per-cluster fake AK/SK pair that the cluster will hand to
   * barman. The proxy verifies these against the value stored on the
   * Database row and translates them to real R2 credentials.
   */
  mintCredentials(): { accessKey: string; secret: string } {
    const accessKey = `orch-${crypto.randomBytes(8).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    return { accessKey, secret };
  }

  /**
   * Binding lifecycle is now implicit: persisting r2ProxyAccessKey on a
   * Database row IS the binding (the proxy joins databases → projects →
   * organizations on every cache miss). These methods stay as no-ops so
   * existing callers in projects.service.ts don't break.
   */
  async addBinding(_opts: R2ProxyBinding): Promise<void> {
    // intentionally empty — proxy reads from DB
  }

  async removeBinding(_accessKey: string): Promise<void> {
    // intentionally empty — proxy reads from DB, removal happens when the
    // Database row is deleted
  }
}
