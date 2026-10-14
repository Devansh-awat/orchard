import {
  SECTIONS,
  type ConfigField,
  type ConfigSection
} from '../instance-config/instance-config.sections';
import { canUseName, ownsName } from './claims';
import type { GraftRecord } from './graft-registry';

export type GraftConfigSection = ConfigSection & {
  graft: string;
  title: string;
  description?: string;
  fieldMeta: Record<
    string,
    { label: string; help?: string; type: string; options?: string[]; public: boolean }
  >;
};

export function graftSectionId(graftId: string, sectionId: string, claimed: string[]): string {
  if (claimed.includes(sectionId) || ownsName(graftId, sectionId)) return sectionId;
  return `${graftId}-${sectionId}`;
}

function envName(graftId: string, sectionId: string, key: string): string {
  return `GRAFT_${graftId}_${sectionId}_${key}`.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

export function registerGraftSettings(record: GraftRecord): void {
  const manifest = record.manifest!;
  const claimed = (record.claims ?? [])
    .filter((c) => c.kind === 'configSections' && c.state !== 'shadowed')
    .map((c) => c.value);
  for (const section of manifest.settings) {
    if (section.fields.some((f) => f.scope !== 'instance')) {
      record.warnings.push(
        `settings section ${section.id}: only instance-scoped fields are supported in this Orchard`
      );
    }
    const id = graftSectionId(record.id, section.id, claimed);
    if (SECTIONS.some((s) => s.id === id)) {
      record.warnings.push(`settings section ${id} is already registered; skipped`);
      continue;
    }
    if (
      section.storageKey &&
      !canUseName(record.id, record.claims, 'settingKeys', section.storageKey)
    ) {
      record.warnings.push(
        `settings section ${section.id}: storageKey ${section.storageKey} is not claimed in settingKeys; using the graft's own key`
      );
    }
    const storageKey =
      section.storageKey && canUseName(record.id, record.claims, 'settingKeys', section.storageKey)
        ? section.storageKey
        : `graft:${record.id}:${section.id}`;
    const fields: ConfigField[] = section.fields.map((f) => ({
      name: f.key,
      env: f.env ?? envName(record.id, section.id, f.key),
      secret: f.type === 'secret' || undefined,
      bool: f.type === 'boolean' || undefined,
      fallback: f.type === 'boolean' && typeof f.default === 'boolean' ? f.default : undefined
    }));
    const registered: GraftConfigSection = {
      id,
      key: storageKey,
      fields,
      required: section.required,
      graft: record.id,
      title: section.title,
      description: section.description,
      fieldMeta: Object.fromEntries(
        section.fields.map((f) => [
          f.key,
          { label: f.label, help: f.help, type: f.type, options: f.options, public: f.public }
        ])
      )
    };
    SECTIONS.push(registered);
  }
}
