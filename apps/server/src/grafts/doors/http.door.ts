import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { activeClaims } from '../claims';
import type { GraftRecord } from '../graft-registry';
import { GraftHttpRegistry, type HostRouter, type UpgradeHandler } from '../http-registry';
import { bindGraft, type DoorMeta } from './door';

@Injectable({ scope: Scope.TRANSIENT })
export class HttpDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'http',
    version: 1,
    status: 'stable',
    capability: 'http.upgrade'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(GraftHttpRegistry) private readonly registry: GraftHttpRegistry
  ) {
    this.graft = bindGraft(parent, HttpDoorV1.meta);
  }

  upgrade(path: string, handler: UpgradeHandler): void {
    const clean = `/${path.replace(/^\/+/, '').replace(/^apiv1\//, '')}`.replace(/\/+$/, '');
    const own = clean === `/${this.graft.id}` || clean.startsWith(`/${this.graft.id}/`);
    const alias = activeClaims(this.graft.claims, 'wsAliases').some(
      (a) => clean === `/${a}` || clean.startsWith(`/${a}/`)
    );
    if (!own && !alias) {
      throw new Error(
        `graft ${this.graft.id} cannot handle upgrades on ${path}: use /apiv1/${this.graft.id}/... or claim it in wsAliases`
      );
    }
    this.registry.addUpgrade(this.graft.id, `/apiv1${clean}`, handler);
  }

  hostRouter(router: HostRouter): void {
    if (!this.graft.manifest!.capabilities.includes('http.hostRouting')) {
      throw new Error(
        `graft ${this.graft.id} needs the "http.hostRouting" capability to route by host`
      );
    }
    this.registry.addHostRouter(this.graft.id, router);
  }
}
