import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { setWildcardOverride } from '../projects/projects.utils';
import { setObjectStorageOverride } from './object-storage';
import { ConfigSection, SECTIONS, STORAGE, WILDCARD } from './instance-config.sections';

export type ConfigValues = Record<string, string | null>;

export interface SectionState {
  id: string;
  configured: boolean;
  values: ConfigValues;
  lockedFields: string[];
  secretFields: string[];
}

/**
 * Runtime configuration that also has an environment variable.
 *
 * Same precedence as the GitHub App config it is modelled on: the environment
 * always wins, and setting a variable locks that field so the UI cannot change
 * it. That is what an operator wants for anything they must control absolutely,
 * and it means a chart-managed instance behaves exactly as before.
 *
 * Reads are synchronous against an in-memory cache because the consumers are
 * synchronous (an S3 client built in a lazy initializer, a mail transport).
 * Those consumers cache their own handles, so `generation` bumps on every write
 * and they rebuild when it moves.
 */
@Injectable()
export class InstanceConfigService implements OnModuleInit {
  private readonly logger = new Logger(InstanceConfigService.name);

  private stored = new Map<string, ConfigValues>();

  private version = 0;

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly crypto: SecretCryptoService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  get generation(): number {
    return this.version;
  }

  async reload(): Promise<void> {
    const next = new Map<string, ConfigValues>();
    for (const section of SECTIONS) {
      try {
        const raw = await this.settings.get(section.key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as ConfigValues;
        const values: ConfigValues = {};
        for (const field of section.fields) {
          const value = parsed[field.name];
          if (value === undefined || value === null || value === '') continue;
          values[field.name] = field.secret ? this.crypto.decrypt(value) : value;
        }
        next.set(section.id, values);
      } catch (e) {
        this.logger.error(`could not read stored config for ${section.id}: ${e}`);
      }
    }
    this.stored = next;
    this.version += 1;

    // projects.utils cannot inject this service without recreating a circular
    // import, so it is pushed the values instead.
    setWildcardOverride(
      next.get(WILDCARD.id)?.domains ?? null,
      this.settingsAppDomain(next),
    );
    setObjectStorageOverride(next.get(STORAGE.id) ?? {});
  }

  private settingsAppDomain(values: Map<string, ConfigValues>): string | null {
    return values.get(WILDCARD.id)?.appDomain ?? null;
  }

  private static env(name: string): string | null {
    const value = process.env[name];
    return value && value.length > 0 ? value : null;
  }

  value(section: ConfigSection, name: string): string | null {
    const field = section.fields.find((f) => f.name === name);
    if (!field) return null;
    return (
      InstanceConfigService.env(field.env) ?? this.stored.get(section.id)?.[name] ?? null
    );
  }

  all(section: ConfigSection): ConfigValues {
    const out: ConfigValues = {};
    for (const field of section.fields) out[field.name] = this.value(section, field.name);
    return out;
  }

  isConfigured(section: ConfigSection): boolean {
    return section.required.every((name) => !!this.value(section, name));
  }

  lockedFields(section: ConfigSection): string[] {
    return section.fields
      .filter((f) => InstanceConfigService.env(f.env) !== null)
      .map((f) => f.name);
  }

  /** Secret values are never returned; the UI shows whether one is set, not what it is. */
  state(section: ConfigSection): SectionState {
    const values = this.all(section);
    const secretFields = section.fields.filter((f) => f.secret).map((f) => f.name);
    for (const name of secretFields) {
      if (values[name]) values[name] = '';
    }
    return {
      id: section.id,
      configured: this.isConfigured(section),
      values,
      lockedFields: this.lockedFields(section),
      secretFields,
    };
  }

  /**
   * An empty string for a secret means "leave what is already stored", so the
   * UI can render a masked field without the operator having to retype a key
   * every time they change an unrelated one.
   */
  async save(section: ConfigSection, input: ConfigValues): Promise<void> {
    const locked = new Set(this.lockedFields(section));
    const current = this.stored.get(section.id) ?? {};
    const next: ConfigValues = {};

    for (const field of section.fields) {
      if (locked.has(field.name)) continue;
      const incoming = input[field.name];
      if (incoming === undefined) {
        if (current[field.name]) next[field.name] = current[field.name];
        continue;
      }
      const trimmed = String(incoming).trim();
      if (field.secret && trimmed === '') {
        if (current[field.name]) next[field.name] = current[field.name];
        continue;
      }
      if (trimmed === '') continue;
      next[field.name] = trimmed;
    }

    const payload: ConfigValues = {};
    for (const field of section.fields) {
      const value = next[field.name];
      if (!value) continue;
      payload[field.name] = field.secret ? this.crypto.encrypt(value) : value;
    }

    await this.settings.set(section.key, JSON.stringify(payload));
    await this.reload();
  }

  async clear(section: ConfigSection): Promise<void> {
    await this.settings.delete(section.key);
    await this.reload();
  }
}
