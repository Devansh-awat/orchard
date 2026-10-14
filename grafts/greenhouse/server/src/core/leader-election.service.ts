import { Inject, Injectable } from '@nestjs/common';
import { Doors, type KubeDoor } from '@orchardlabs/graft-sdk/server';

@Injectable()
export class LeaderElectionService {
  constructor(@Inject(Doors.kube) private readonly kube: KubeDoor) {}

  isLeader(): boolean {
    return this.kube.isLeader();
  }

  onAcquired(listener: () => void): void {
    this.kube.onLeaderAcquired(listener);
  }
}
