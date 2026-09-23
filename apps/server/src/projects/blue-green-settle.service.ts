import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { DeploymentsService } from './deployments.service';

const SWEEP_MS = 60_000;

/**
 * A blue/green rollout has two selector writes with a rolling update of blue
 * in between. If the process dies after the first write, traffic is on green
 * and blue is stale, which is safe but not where anyone expects the app to
 * live. This sweep finishes the job for any deployment that still has a green:
 * bring blue to green's image, move traffic back, remove green. It reads the
 * cluster each pass and never trusts memory, so it is also what unsticks a
 * blue that failed to settle inline once whatever blocked it clears.
 */
@Injectable()
export class BlueGreenSettleService {
  private readonly logger = new Logger(BlueGreenSettleService.name);

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly leader: LeaderElectionService,
    private readonly deployments: DeploymentsService
  ) {}

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (!this.leader.isLeader()) return;
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.deployment.findMany({
        where: { deployStrategy: 'blueGreen', buildStatus: { not: 'building' } },
        select: { id: true, name: true, namespace: true },
        take: 50
      });
      for (const row of rows) {
        await this.settleOne(row).catch((err) =>
          this.logger.warn(
            `settle failed for ${row.namespace}/${row.name}: ${err instanceof Error ? err.message : err}`
          )
        );
      }
    } catch (err) {
      this.logger.warn(`blue/green sweep failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }

  private async settleOne(row: { id: string; name: string; namespace: string }): Promise<void> {
    const green = await this.k8sWorkload.findGreen(row.name, row.namespace);
    if (!green) return;
    this.logger.log(`finishing blue/green for ${row.namespace}/${row.name} (${green.image})`);
    const { healthCheck, args } = await this.deployments.rolloutInputs(row.id);
    await this.k8sWorkload.settleBlueGreen({
      deploymentName: row.name,
      namespace: row.namespace,
      image: green.image,
      healthCheck,
      args,
      log: (line) => this.logger.log(`${row.namespace}/${row.name}: ${line}`)
    });
  }
}
