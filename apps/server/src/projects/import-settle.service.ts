import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { QuotasService } from '../quotas/quotas.service';

@Injectable()
export class ImportSettleService {
  private readonly logger = new Logger(ImportSettleService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly leader: LeaderElectionService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotas: QuotasService
  ) {}

  @Interval(30_000)
  async tick() {
    if (!this.leader.isLeader() || this.ticking) return;
    this.ticking = true;
    try {
      const boosted = await this.prisma.database.findMany({
        where: { importBoosted: true, mode: 'cnpg' },
        select: {
          id: true,
          namespace: true,
          clusterName: true,
          projectId: true,
          cpuRequestMilli: true,
          memoryRequestBytes: true
        },
        take: 20
      });
      for (const db of boosted) {
        if (!db.namespace || !db.clusterName) continue;
        try {
          const status = await this.k8sCnpg.getCnpgProvisioningStatus(db.namespace, db.clusterName);
          if (!status?.exists) {
            await this.clearFlag(db.id);
            continue;
          }
          if (!status.ready) continue;
          const requested = await this.quotas.resolvePodResources(
            db.projectId,
            {
              cpuRequestMilli: db.cpuRequestMilli,
              memoryRequestBytes:
                db.memoryRequestBytes != null ? Number(db.memoryRequestBytes) : null
            },
            'postgres'
          );
          await this.k8sCnpg.updateCnpgClusterResources(db.namespace, db.clusterName, {
            cpuMilli: requested.cpuMilli,
            memoryBytes: requested.memoryBytes
          });
          await this.clearFlag(db.id);
          this.logger.log(
            `settled import boost for database ${db.id} back to ${requested.cpuMilli}m / ${requested.memoryBytes} bytes`
          );
        } catch (e: any) {
          this.logger.warn(`import settle failed for database ${db.id}: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async clearFlag(databaseId: string) {
    await this.prisma.database.updateMany({
      where: { id: databaseId, importBoosted: true },
      data: { importBoosted: false }
    });
  }
}
