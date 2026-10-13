import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { registerExecRoute, type ExecRouteHooks } from '../../kubernetes/exec-session-engine';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class ExecDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'exec',
    version: 1,
    status: 'stable',
    capability: 'kube.exec'
  };

  constructor(@Inject(INQUIRER) parent: unknown) {
    bindGraft(parent, ExecDoorV1.meta);
  }

  register(hooks: ExecRouteHooks): void {
    registerExecRoute(hooks);
  }
}
