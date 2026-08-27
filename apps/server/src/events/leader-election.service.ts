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

  // Leadership is acquired asynchronously: LeaseElector.start() kicks off its
  // first tick without awaiting it, so isLeader() is false for the whole first
  // round-trip. Anything that does a one-shot pass at startup and then only
  // reacts to live events will silently lose that pass, because it runs before
  // this replica knows it is the leader.
  //
  // Subscribing here gives you a callback at the moment leadership lands, which
  // is the right time to do the pass instead.
  onAcquired(listener: () => void): void {
    this.lease.onAcquired(GLOBAL_LEADER_LEASE, listener);
  }
}
