import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Stable keys for instance settings. Each may have a matching env override.
export const USERSPACE_NODE_SCHEDULING_KEY = 'userspace_node_scheduling';
const USERSPACE_NODE_SCHEDULING_ENV = 'USERSPACE_NODE_SCHEDULING';

export interface ToggleState {
  // Effective value after applying the env override.
  enabled: boolean;
  // The stored admin-panel value (ignored while an env override is active).
  dbValue: boolean;
  // null = no override; true/false = env pins the value and the toggle is locked.
  envOverride: boolean | null;
}

// DB-backed instance settings with an env-var override layer. A key's env var,
// when explicitly set to 'true'/'false', wins over the stored value at read
// time; otherwise the admin-panel toggle (persisted here) decides.
@Injectable()
export class InstanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getRaw(key: string): Promise<string | null> {
    const row = await this.prisma.instanceSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  async setBool(key: string, value: boolean): Promise<void> {
    const str = value ? 'true' : 'false';
    await this.prisma.instanceSetting.upsert({
      where: { key },
      create: { key, value: str },
      update: { value: str },
    });
  }

  private envOverride(envVar: string): boolean | null {
    const v = process.env[envVar];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  private async resolveBool(key: string, envVar: string): Promise<boolean> {
    const env = this.envOverride(envVar);
    if (env !== null) return env;
    return (await this.getRaw(key)) === 'true';
  }

  private async toggleState(key: string, envVar: string): Promise<ToggleState> {
    const envOverride = this.envOverride(envVar);
    const dbValue = (await this.getRaw(key)) === 'true';
    return { enabled: envOverride ?? dbValue, dbValue, envOverride };
  }

  isUserspaceSchedulingEnabled(): Promise<boolean> {
    return this.resolveBool(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  getUserspaceSchedulingState(): Promise<ToggleState> {
    return this.toggleState(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  setUserspaceScheduling(value: boolean): Promise<void> {
    return this.setBool(USERSPACE_NODE_SCHEDULING_KEY, value);
  }
}
