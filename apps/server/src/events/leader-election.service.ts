import { Injectable, OnModuleInit } from '@nestjs/common';
import { GLOBAL_LEADER_LEASE, LeaseService } from '../coordination/lease.service';

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
