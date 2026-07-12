import { Global, Module, OnModuleInit, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from './secret-crypto.service';

/**
 * One-time retroactive backfill: encrypt any secret env-var rows still stored in
 * plaintext. Idempotent (skips rows already `enc:v1:` prefixed) and a no-op when
 * no encryption key is configured.
 */
@Injectable()
class SecretBackfillService implements OnModuleInit {
  private readonly logger = new Logger(SecretBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.crypto.enabled) return;
    try {
      const rows = await this.prisma.environmentSharedVar.findMany({
        where: { secret: true },
        select: { id: true, value: true },
      });
      let n = 0;
      for (const r of rows) {
        if (this.crypto.isEncrypted(r.value)) continue;
        await this.prisma.environmentSharedVar.update({
          where: { id: r.id },
          data: { value: this.crypto.encrypt(r.value) },
        });
        n++;
      }
      if (n) this.logger.log(`encrypted ${n} plaintext shared secret var(s) at rest`);
    } catch (e: any) {
      this.logger.error(`secret backfill failed: ${e?.message}`);
    }
  }
}

@Global()
@Module({
  providers: [SecretCryptoService, SecretBackfillService],
  exports: [SecretCryptoService],
})
export class CryptoModule {}
