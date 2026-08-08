import { Injectable, OnModuleInit } from '@nestjs/common';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';

// Thin shim kept for its call sites: every leader-guarded sweep injects this
// and asks isLeader(). Election itself moved to a coordination.k8s.io Lease
// (LeaseService) — the old Redis lock, and its everyone-is-leader fallback
// when REDIS_URL was unset, are gone.
@Injectable()
export class LeaderElectionService implements OnModuleInit {
  constructor(private readonly lease: LeaseService) {}

  onModuleInit() {
    this.lease.register(GLOBAL_LEADER_LEASE);
  }

  isLeader(): boolean {
    return this.lease.isHolder(GLOBAL_LEADER_LEASE);
  }
}
