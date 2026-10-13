import { Inject, Injectable } from '@nestjs/common';
import { Doors, type SettingsDoor } from '@orchard/graft-sdk/server';

@Injectable()
export class InstanceSettingsService {
  constructor(@Inject(Doors.settings) private readonly settings: SettingsDoor) {}

  async isSandboxesEnabled(): Promise<boolean> {
    return true;
  }

  get(key: string): Promise<string | null> {
    return this.settings.stored(key);
  }

  createIfAbsent(key: string, value: string): Promise<boolean> {
    return this.settings.storeIfAbsent(key, value);
  }
}
