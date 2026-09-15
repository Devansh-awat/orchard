import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SandboxK8sService } from '../../sandboxes/sandbox-k8s.service';
import { readSandboxCr, sandboxStatusFromCr } from '../../sandboxes/sandbox-cr';
import { MirrorEventType, MirrorObjectKey } from '../mirror-informer';

@Injectable()
export class SandboxMirrorConsumer {
  private readonly logger = new Logger(SandboxMirrorConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8s: SandboxK8sService
  ) {}

  /**
   * Derive a sandbox row from the resource the cluster holds. This is the whole
   * of sandbox status: a resource that goes ready, gets suspended or disappears
   * says so in a watch event, and the row follows it. Nothing polls.
   *
   * Throws on a failed write rather than swallowing it — the informer holds the
   * object's derived_version back and comes round again, which is the only
   * thing that gets a missed transition applied.
   */
  async onEvent(type: MirrorEventType, cr: any): Promise<void> {
    const podName = cr?.metadata?.name;
    if (!podName) return;
    const row = await this.prisma.sandbox.findUnique({
      where: { podName },
      select: { id: true, status: true }
    });
    // A row mid-delete is on its way out under its own power, and one that does
    // not exist is either an orphan (swept below) or another install's.
    if (!row || row.status === 'deleting') return;

    if (type === 'delete') {
      await this.prisma.sandbox.update({
        where: { id: row.id },
        data: { status: 'error', statusMessage: 'Sandbox resource disappeared from the cluster' }
      });
      return;
    }

    const status = sandboxStatusFromCr(readSandboxCr(cr));
    if (!status || status === row.status) return;
    await this.prisma.sandbox.update({
      where: { id: row.id },
      data: { status, statusMessage: null }
    });
  }

  /**
   * Delete cluster resources this install owns that no sandbox row claims — a
   * sandbox whose delete half-finished, or whose row was removed under it.
   *
   * Two things make this safe to run, and it is worth being explicit about them
   * because getting it wrong once already cost two sandboxes and their disks.
   * The shard's informer selects on this install's instance label, so another
   * Orchard server's sandboxes are not merely filtered out here, they are never
   * listed. And this only runs at the end of a list pass that completed, so
   * "not in the set" means the cluster was asked and did not have it, rather
   * than meaning nobody looked.
   */
  async sweepOrphans(seen: MirrorObjectKey[]): Promise<void> {
    const names = seen.map((key) => key.name).filter(Boolean);
    if (names.length === 0) return;
    const known = await this.prisma.sandbox.findMany({
      where: { podName: { in: names } },
      select: { podName: true }
    });
    const claimed = new Set(known.map((r) => r.podName));
    for (const name of names) {
      if (claimed.has(name)) continue;
      this.logger.warn(`deleting orphan sandbox resource ${name}`);
      const id = name.match(/^sbx-(.+)$/)?.[1] ?? name;
      await this.k8s
        .deleteSandbox({ id, podName: name })
        .catch((e: any) => this.logger.warn(`orphan delete failed for ${name}: ${e?.message}`));
    }
  }
}
