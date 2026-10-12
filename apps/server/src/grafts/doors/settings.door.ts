import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { InstanceConfigService } from '../../instance-config/instance-config.service';
import { sectionById } from '../../instance-config/instance-config.sections';
import type { GraftRecord } from '../graft-registry';
import { graftSectionId } from '../settings';
import { bindGraft, type DoorMeta } from './door';

function resolveSection(graft: GraftRecord, sectionId: string) {
  const declared = graft.manifest!.settings.find((s) => s.id === sectionId);
  if (!declared) throw new Error(`graft ${graft.id} has no settings section "${sectionId}"`);
  const claimed = (graft.claims ?? [])
    .filter((c) => c.kind === 'configSections' && c.state !== 'shadowed')
    .map((c) => c.value);
  const section = sectionById(graftSectionId(graft.id, sectionId, claimed));
  if (!section) throw new Error(`settings section "${sectionId}" is not registered`);
  return section;
}

@Injectable({ scope: Scope.TRANSIENT })
export class SettingsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'settings',
    version: 1,
    status: 'stable',
    capability: 'settings'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(InstanceConfigService) private readonly config: InstanceConfigService
  ) {
    this.graft = bindGraft(parent, SettingsDoorV1.meta);
  }

  all(sectionId: string): Record<string, string | null> {
    return this.config.all(resolveSection(this.graft, sectionId));
  }

  value(sectionId: string, key: string): string | null {
    return this.config.value(resolveSection(this.graft, sectionId), key);
  }

  flag(sectionId: string, key: string): boolean {
    return this.config.flag(resolveSection(this.graft, sectionId), key);
  }

  isConfigured(sectionId: string): boolean {
    return this.config.isConfigured(resolveSection(this.graft, sectionId));
  }

  get generation(): number {
    return this.config.generation;
  }
}
