import { Inject, Injectable } from '@nestjs/common';
import { Doors, type SettingsDoor } from '@orchardlabs/graft-sdk/server';
import type { SectionId } from './instance-config.sections';

@Injectable()
export class InstanceConfigService {
  constructor(@Inject(Doors.settings) private readonly settings: SettingsDoor) {}

  get generation(): number {
    return this.settings.generation;
  }

  value(section: SectionId, key: string): string | null {
    return this.settings.value(section, key);
  }

  flag(section: SectionId, key: string): boolean {
    return this.settings.flag(section, key);
  }

  all(section: SectionId): Record<string, string | null> {
    return this.settings.all(section);
  }

  isConfigured(section: SectionId): boolean {
    return this.settings.isConfigured(section);
  }
}
