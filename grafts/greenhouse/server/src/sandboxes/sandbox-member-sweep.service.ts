import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LeaderElectionService } from '../core/leader-election.service';
import { SandboxMembersService } from './sandbox-members.service';

const SWEEP_MS = 5 * 60 * 1000;

@Injectable()
export class SandboxMemberSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxMemberSweepService.name);

  private timer: NodeJS.Timeout | null = null;

  private running = false;

  constructor(
    private readonly leader: LeaderElectionService,
    private readonly members: SandboxMembersService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running || !this.leader.isLeader()) return;
    this.running = true;
    try {
      const removed = await this.members.sweepDeparted();
      if (removed > 0) this.logger.log(`removed ${removed} guests who left their organization`);
    } catch (e: any) {
      this.logger.warn(`member sweep failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
