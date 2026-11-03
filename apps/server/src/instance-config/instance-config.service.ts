import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { setWildcardOverride } from '../projects/projects.utils';
import { setObjectStorageOverride } from './object-storage';
import { ConfigSection, NETWORK, SECTIONS, STORAGE, WILDCARD } from './instance-config.sections';

export type ConfigValues = Record<string, string | null>;

const RELOAD_INTERVAL_MS = 30_000;

export interface SectionState {
  id: string;
  configured: boolean;
  values: ConfigValues;
  lockedFields: string[];
  secretFields: string[];
  boolFields: string[];
  graft?: {
    id: string;
    title: string;
    description?: string;
    fields: Record<string, { label: string; help?: string }>;
  };
}

/**
 * Runtime configuration that also has an environment variable.
 *
 * Same precedence as the GitHub App config it is modelled on: the environment
 * always wins, and setting a variable locks that field so nothing can change
 * it: a write that would is refused, not dropped. That is what an operator
 * wants for anything they must control absolutely, and it means a
 * chart-managed instance behaves exactly as before.
 *
 * Reads are synchronous against an in-memory cache because the consumers are
 * synchronous (an S3 client built in a lazy initializer, a mail transport).
 * Those consumers cache their own handles, so `generation` bumps on every write
 * and they rebuild when it moves.
 */
@Injectable()
export class InstanceConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InstanceConfigService.name);

  private stored = new Map<string, ConfigValues>();

  private snapshot: string | null = null;

  private version = 0;

  private reloadTimer: ReturnType<typeof setInterval> | null = null;

  private wildcardHandlers: (() => Promise<unknown>)[] = [];

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly crypto: SecretCryptoService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.reloadTimer = setInterval(() => {
      void this.reload().catch((e) => this.logger.warn(`periodic config reload failed: ${e}`));
    }, RELOAD_INTERVAL_MS);
    this.reloadTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.reloadTimer = null;
  }

  /**
   * Existing ingresses chose their TLS secret when they were created, so a
   * wildcard added or removed later leaves them stale. IngressService registers
   * itself here rather than being injected: it pulls in most of the app, and a
   * constructor edge from this service would be a circular import.
   */
  onWildcardChange(handler: () => Promise<unknown>): void {
    this.wildcardHandlers.push(handler);
  }

  private async reconcileWildcards(): Promise<void> {
    for (const handler of this.wildcardHandlers) {
      try {
        await handler();
      } catch (e: any) {
        this.logger.warn(`wildcard reconcile failed: ${e?.message}`);
      }
    }
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
    const snapshot = JSON.stringify([...next.entries()]);
    if (snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    this.stored = next;
    this.version += 1;

    // projects.utils cannot inject this service without recreating a circular
    // import, so it is pushed the values instead.
    setWildcardOverride(next.get(WILDCARD.id)?.domains ?? null, this.settingsAppDomain(next));
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
    return InstanceConfigService.env(field.env) ?? this.stored.get(section.id)?.[name] ?? null;
  }

  flag(section: ConfigSection, name: string): boolean {
    const field = section.fields.find((f) => f.name === name);
    if (!field) return false;
    const raw = this.value(section, name);
    if (raw === null) return field.fallback ?? false;
    return raw.trim().toLowerCase() === 'true';
  }

  all(section: ConfigSection): ConfigValues {
    const out: ConfigValues = {};
    for (const field of section.fields) out[field.name] = this.value(section, field.name);
    return out;
  }

  isConfigured(section: ConfigSection): boolean {
    return section.required.every((name) => !!this.value(section, name));
  }

  /**
   * The instance-wide fallback for public exposure. An organization with its
   * own address overrides this; one without it inherits rather than refusing.
   */
  defaultPublicIp(): string {
    return (this.value(NETWORK, 'publicIp') || '').trim();
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
    const boolFields = section.fields.filter((f) => f.bool).map((f) => f.name);
    for (const name of boolFields) {
      values[name] = String(this.flag(section, name));
    }
    const graftSection = section as ConfigSection & {
      graft?: string;
      title?: string;
      description?: string;
      fieldMeta?: Record<string, { label: string; help?: string }>;
    };
    return {
      id: section.id,
      configured: this.isConfigured(section),
      values,
      lockedFields: this.lockedFields(section),
      secretFields,
      boolFields,
      ...(graftSection.graft
        ? {
            graft: {
              id: graftSection.graft,
              title: graftSection.title ?? section.id,
              description: graftSection.description,
              fields: Object.fromEntries(
                Object.entries(graftSection.fieldMeta ?? {}).map(([name, f]) => [
                  name,
                  { label: f.label, help: f.help }
                ])
              )
            }
          }
        : {})
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
      const incoming = input[field.name];

      // A locked field is read-only for every client, not only for the panel
      // that greys the input out. Echoing the value already in effect is still
      // fine, because that is what saving an unrelated field in the same
      // section sends back. The stored value is carried over untouched: it is
      // what the field falls back to if the variable is ever unset, and
      // dropping it here would delete that on the next unrelated save.
      if (locked.has(field.name)) {
        const pinned = InstanceConfigService.env(field.env) ?? '';
        const proposed = incoming === undefined ? null : String(incoming).trim();
        const same = field.bool
          ? proposed?.toLowerCase() === pinned.trim().toLowerCase()
          : proposed === pinned;
        const changes = proposed !== null && !same && !(field.secret && proposed === '');
        if (changes) {
          throw new ConflictException(
            `${field.name} is set by the ${field.env} environment variable and cannot be changed here`
          );
        }
        if (current[field.name]) next[field.name] = current[field.name];
        continue;
      }

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

    try {
      section.validate?.(next);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'That value is not valid');
    }

    const payload: ConfigValues = {};
    for (const field of section.fields) {
      const value = next[field.name];
      if (!value) continue;
      payload[field.name] = field.secret ? this.crypto.encrypt(value) : value;
    }

    await this.settings.set(section.key, JSON.stringify(payload));
    await this.reload();
    if (section.id === WILDCARD.id) await this.reconcileWildcards();
  }

  async clear(section: ConfigSection): Promise<void> {
    await this.settings.delete(section.key);
    await this.reload();
    if (section.id === WILDCARD.id) await this.reconcileWildcards();
  }
}
