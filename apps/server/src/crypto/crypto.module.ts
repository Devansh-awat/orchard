import { Global, Module, OnModuleInit, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from './secret-crypto.service';

/**
 * One-time retroactive backfill: encrypt any secret env-var rows still stored in
 * plaintext, shared and per-deployment alike. Idempotent (skips rows already
 * `enc:v1:` prefixed) and a no-op when no encryption key is configured.
 */
@Injectable()
class SecretBackfillService implements OnModuleInit {
  private readonly logger = new Logger(SecretBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.crypto.enabled) return;
    try {
      await this.backfillEnvVars();
      await this.backfillCredentials();
    } catch (e: any) {
      this.logger.error(`secret backfill failed: ${e?.message}`);
    }
  }

  private async backfillEnvVars(): Promise<void> {
    const shared = await this.encryptPlaintext(
      () =>
        this.prisma.environmentSharedVar.findMany({
          where: { secret: true },
          select: { id: true, value: true }
        }),
      (id, value) => this.prisma.environmentSharedVar.update({ where: { id }, data: { value } })
    );
    if (shared) this.logger.log(`encrypted ${shared} plaintext shared secret var(s) at rest`);

    const own = await this.encryptPlaintext(
      () =>
        this.prisma.deploymentEnvVar.findMany({
          where: { secret: true },
          select: { id: true, value: true }
        }),
      (id, value) => this.prisma.deploymentEnvVar.update({ where: { id }, data: { value } })
    );
    if (own) this.logger.log(`encrypted ${own} plaintext deployment secret var(s) at rest`);
  }

  private async backfillCredentials(): Promise<void> {
    const pick =
      <K extends string>(key: K) =>
      (rows: Array<{ id: string } & Record<K, string | null>>) =>
        rows.flatMap((r) => (r[key] ? [{ id: r.id, value: r[key] as string }] : []));

    const columns: Array<{
      label: string;
      read: () => Promise<{ id: string; value: string }[]>;
      write: (id: string, value: string) => Promise<unknown>;
    }> = [
      {
        label: 'github access token',
        read: () =>
          this.prisma.user
            .findMany({
              where: { githubAccessToken: { not: null } },
              select: { id: true, githubAccessToken: true }
            })
            .then(pick('githubAccessToken')),
        write: (id, githubAccessToken) =>
          this.prisma.user.update({ where: { id }, data: { githubAccessToken } })
      },
      {
        label: 'github refresh token',
        read: () =>
          this.prisma.user
            .findMany({
              where: { githubRefreshToken: { not: null } },
              select: { id: true, githubRefreshToken: true }
            })
            .then(pick('githubRefreshToken')),
        write: (id, githubRefreshToken) =>
          this.prisma.user.update({ where: { id }, data: { githubRefreshToken } })
      },
      {
        label: 'organization backup secret key',
        read: () =>
          this.prisma.organization
            .findMany({
              where: { backupR2SecretKey: { not: null } },
              select: { id: true, backupR2SecretKey: true }
            })
            .then(pick('backupR2SecretKey')),
        write: (id, backupR2SecretKey) =>
          this.prisma.organization.update({ where: { id }, data: { backupR2SecretKey } })
      },
      {
        label: 'database password',
        read: () =>
          this.prisma.database
            .findMany({ select: { id: true, dbPassword: true } })
            .then(pick('dbPassword')),
        write: (id, dbPassword) =>
          this.prisma.database.update({ where: { id }, data: { dbPassword } })
      },
      {
        label: 'git connection webhook secret',
        read: () =>
          this.prisma.gitConnection
            .findMany({ select: { id: true, webhookSecret: true } })
            .then(pick('webhookSecret')),
        write: (id, webhookSecret) =>
          this.prisma.gitConnection.update({ where: { id }, data: { webhookSecret } })
      },
      {
        label: 'tailscale auth key',
        read: () =>
          this.prisma.tailscaleConnection
            .findMany({ select: { id: true, accessToken: true } })
            .then(pick('accessToken')),
        write: (id, accessToken) =>
          this.prisma.tailscaleConnection.update({ where: { id }, data: { accessToken } })
      },
      {
        label: 'ingress bypass secret',
        read: () =>
          this.prisma.ingress
            .findMany({
              where: { protectionBypassSecret: { not: null } },
              select: { id: true, protectionBypassSecret: true }
            })
            .then(pick('protectionBypassSecret')),
        write: (id, protectionBypassSecret) =>
          this.prisma.ingress.update({ where: { id }, data: { protectionBypassSecret } })
      }
    ];

    for (const column of columns) {
      const n = await this.encryptPlaintext(column.read, column.write);
      if (n) this.logger.log(`encrypted ${n} plaintext ${column.label}(s) at rest`);
    }
  }

  private async encryptPlaintext(
    read: () => Promise<{ id: string; value: string }[]>,
    write: (id: string, value: string) => Promise<unknown>
  ): Promise<number> {
    let n = 0;
    for (const row of await read()) {
      if (this.crypto.isEncrypted(row.value)) continue;
      await write(row.id, this.crypto.encrypt(row.value));
      n++;
    }
    return n;
  }
}

@Global()
@Module({
  providers: [SecretCryptoService, SecretBackfillService],
  exports: [SecretCryptoService]
})
export class CryptoModule {}
