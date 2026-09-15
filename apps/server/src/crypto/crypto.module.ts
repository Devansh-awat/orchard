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
    } catch (e: any) {
      this.logger.error(`secret backfill failed: ${e?.message}`);
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
