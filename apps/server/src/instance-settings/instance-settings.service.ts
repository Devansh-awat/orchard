import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const USERSPACE_NODE_SCHEDULING_KEY = 'userspace_node_scheduling';
const USERSPACE_NODE_SCHEDULING_ENV = 'USERSPACE_NODE_SCHEDULING';

export const MCP_ENABLED_KEY = 'mcp_enabled';
const MCP_ENABLED_ENV = 'MCP_ENABLED';

export interface ToggleState {
  enabled: boolean;
  dbValue: boolean;
  envOverride: boolean | null;
}

@Injectable()
export class InstanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async getRaw(key: string): Promise<string | null> {
    const row = await this.prisma.instanceSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  get(key: string): Promise<string | null> {
    return this.getRaw(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.instanceSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value }
    });
  }

  async createIfAbsent(key: string, value: string): Promise<boolean> {
    try {
      await this.prisma.instanceSetting.create({ data: { key, value } });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.prisma.instanceSetting.deleteMany({ where: { key } });
  }

  async setBool(key: string, value: boolean): Promise<void> {
    const str = value ? 'true' : 'false';
    await this.prisma.instanceSetting.upsert({
      where: { key },
      create: { key, value: str },
      update: { value: str }
    });
  }

  private envOverride(envVar: string): boolean | null {
    const v = process.env[envVar];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  // A toggle with nothing stored takes its fallback, so a feature that ships on
  // stays on until somebody turns it off rather than needing a row written at
  // install time that an upgraded instance would never get.
  private async storedBool(key: string, fallback: boolean): Promise<boolean> {
    const raw = await this.getRaw(key);
    if (raw === null) return fallback;
    return raw === 'true';
  }

  private async resolveBool(key: string, envVar: string, fallback = false): Promise<boolean> {
    const env = this.envOverride(envVar);
    if (env !== null) return env;
    return this.storedBool(key, fallback);
  }

  /**
   * A variable that pins a toggle makes it read-only for everyone, not just for
   * the admin panel that hides the switch. Refusing the write is the difference
   * between a lock and a suggestion: an accepted write changes nothing now and
   * then silently becomes the instance's answer the day the variable is unset.
   */
  private assertUnlocked(envVar: string): void {
    if (this.envOverride(envVar) === null) return;
    throw new ConflictException(
      `This is pinned by the ${envVar} environment variable. Unset it to change this here.`
    );
  }

  private async toggleState(key: string, envVar: string, fallback = false): Promise<ToggleState> {
    const envOverride = this.envOverride(envVar);
    const dbValue = await this.storedBool(key, fallback);
    return { enabled: envOverride ?? dbValue, dbValue, envOverride };
  }

  isUserspaceSchedulingEnabled(): Promise<boolean> {
    return this.resolveBool(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  getUserspaceSchedulingState(): Promise<ToggleState> {
    return this.toggleState(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  async setUserspaceScheduling(value: boolean): Promise<void> {
    this.assertUnlocked(USERSPACE_NODE_SCHEDULING_ENV);
    await this.setBool(USERSPACE_NODE_SCHEDULING_KEY, value);
  }

  isMcpEnabled(): Promise<boolean> {
    return this.resolveBool(MCP_ENABLED_KEY, MCP_ENABLED_ENV, true);
  }

  getMcpState(): Promise<ToggleState> {
    return this.toggleState(MCP_ENABLED_KEY, MCP_ENABLED_ENV, true);
  }

  async setMcp(value: boolean): Promise<void> {
    this.assertUnlocked(MCP_ENABLED_ENV);
    await this.setBool(MCP_ENABLED_KEY, value);
  }
}
