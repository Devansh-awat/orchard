import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const USERSPACE_NODE_SCHEDULING_KEY = 'userspace_node_scheduling';
const USERSPACE_NODE_SCHEDULING_ENV = 'USERSPACE_NODE_SCHEDULING';

export const MCP_ENABLED_KEY = 'mcp_enabled';
const MCP_ENABLED_ENV = 'MCP_ENABLED';

export const SSO_ENFORCED_KEY = 'sso_enforced';
export const SSO_ENFORCED_ENV = 'SSO_ENFORCED';

export const POSTGRES_AUTO_UPDATE_KEY = 'postgres_auto_update';
export const POSTGRES_AUTO_UPDATE_ENV = 'POSTGRES_AUTO_UPDATE';

export const IMAGE_SCANNER_KEY = 'image_scanner';
export const IMAGE_SCANNER_ENV = 'IMAGE_SCANNER';
export const IMAGE_SCANNERS = ['off', 'harbor', 'trivy'] as const;
export type ImageScannerChoice = (typeof IMAGE_SCANNERS)[number];

export interface ChoiceState<T extends string> {
  value: T;
  dbValue: T;
  envOverride: T | null;
}

export function parseImageScanner(raw: string | null | undefined): ImageScannerChoice | null {
  const v = (raw ?? '').trim().toLowerCase();
  return (IMAGE_SCANNERS as readonly string[]).includes(v) ? (v as ImageScannerChoice) : null;
}

export const DATABASE_TOGGLES = {
  ddlCheckpoints: { key: 'db_ddl_checkpoints', env: 'DB_DDL_CHECKPOINTS', fallback: true },
  restoreDrills: { key: 'db_restore_drills', env: 'DB_RESTORE_DRILLS', fallback: false },
  pluginMigration: {
    key: 'db_barman_plugin_migration',
    env: 'CNPG_BARMAN_PLUGIN_MIGRATE',
    fallback: false
  },
  poolerByDefault: { key: 'db_pooler_by_default', env: 'DB_POOLER_BY_DEFAULT', fallback: true }
} as const;

export type DatabaseToggle = keyof typeof DATABASE_TOGGLES;

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

  isSsoEnforced(): Promise<boolean> {
    return this.resolveBool(SSO_ENFORCED_KEY, SSO_ENFORCED_ENV);
  }

  getSsoEnforcedState(): Promise<ToggleState> {
    return this.toggleState(SSO_ENFORCED_KEY, SSO_ENFORCED_ENV);
  }

  async setSsoEnforced(value: boolean): Promise<void> {
    this.assertUnlocked(SSO_ENFORCED_ENV);
    await this.setBool(SSO_ENFORCED_KEY, value);
  }

  isDatabaseToggleOn(name: DatabaseToggle): Promise<boolean> {
    const t = DATABASE_TOGGLES[name];
    return this.resolveBool(t.key, t.env, t.fallback);
  }

  async getDatabaseToggles(): Promise<Record<DatabaseToggle, ToggleState>> {
    const names = Object.keys(DATABASE_TOGGLES) as DatabaseToggle[];
    const states = await Promise.all(
      names.map((n) =>
        this.toggleState(
          DATABASE_TOGGLES[n].key,
          DATABASE_TOGGLES[n].env,
          DATABASE_TOGGLES[n].fallback
        )
      )
    );
    return Object.fromEntries(names.map((n, i) => [n, states[i]])) as Record<
      DatabaseToggle,
      ToggleState
    >;
  }

  async setDatabaseToggle(name: DatabaseToggle, value: boolean): Promise<void> {
    const t = DATABASE_TOGGLES[name];
    this.assertUnlocked(t.env);
    await this.setBool(t.key, value);
  }

  isPostgresAutoUpdateEnabled(): Promise<boolean> {
    return this.resolveBool(POSTGRES_AUTO_UPDATE_KEY, POSTGRES_AUTO_UPDATE_ENV, true);
  }

  getPostgresAutoUpdateState(): Promise<ToggleState> {
    return this.toggleState(POSTGRES_AUTO_UPDATE_KEY, POSTGRES_AUTO_UPDATE_ENV, true);
  }

  async setPostgresAutoUpdate(value: boolean): Promise<void> {
    this.assertUnlocked(POSTGRES_AUTO_UPDATE_ENV);
    await this.setBool(POSTGRES_AUTO_UPDATE_KEY, value);
  }

  async getImageScannerState(): Promise<ChoiceState<ImageScannerChoice>> {
    const envOverride = parseImageScanner(process.env[IMAGE_SCANNER_ENV]);
    const dbValue = parseImageScanner(await this.getRaw(IMAGE_SCANNER_KEY)) ?? 'off';
    return { value: envOverride ?? dbValue, dbValue, envOverride };
  }

  async imageScanner(): Promise<ImageScannerChoice> {
    return (await this.getImageScannerState()).value;
  }

  async setImageScanner(value: ImageScannerChoice): Promise<void> {
    if (parseImageScanner(process.env[IMAGE_SCANNER_ENV]) !== null) {
      throw new ConflictException(
        `This is pinned by the ${IMAGE_SCANNER_ENV} environment variable. Unset it to change this here.`
      );
    }
    await this.set(IMAGE_SCANNER_KEY, value);
  }
}
