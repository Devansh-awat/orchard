import type { Provider, Type } from '@nestjs/common';
import { Scope } from '@nestjs/common';
import { AuditDoorV1 } from './audit.door';
import { AuthDoorV1 } from './auth.door';
import { ContextDoorV1 } from './context.door';
import { DbDoorV1 } from './db.door';
import { doorToken, type DoorMeta } from './door';
import { EventsDoorV1 } from './events.door';
import { FlagsDoorV1 } from './flags.door';
import { HttpDoorV1 } from './http.door';
import { SecretsDoorV1 } from './secrets.door';
import { SettingsDoorV1 } from './settings.door';
import { UsersDoorV1 } from './users.door';

type DoorClass = Type<unknown> & { meta: DoorMeta };

export const DOOR_CLASSES: DoorClass[] = [
  ContextDoorV1,
  AuthDoorV1,
  UsersDoorV1,
  AuditDoorV1,
  SecretsDoorV1,
  FlagsDoorV1,
  SettingsDoorV1,
  EventsDoorV1,
  DbDoorV1,
  HttpDoorV1
];

export function doorProviders(): Provider[] {
  return DOOR_CLASSES.map((cls) => ({
    provide: doorToken(cls.meta.name, cls.meta.version),
    useClass: cls,
    scope: Scope.TRANSIENT
  }));
}

export function doorTokens(): symbol[] {
  return DOOR_CLASSES.map((cls) => doorToken(cls.meta.name, cls.meta.version));
}

export type DoorDescription = {
  status: DoorMeta['status'];
  removeIn?: string;
  capability: string | null;
  methods: Record<string, number>;
  properties: string[];
};

export function describeDoors(): Record<string, DoorDescription> {
  const out: Record<string, DoorDescription> = {};
  for (const cls of [...DOOR_CLASSES].sort((a, b) =>
    `${a.meta.name}@${a.meta.version}`.localeCompare(`${b.meta.name}@${b.meta.version}`)
  )) {
    const proto = cls.prototype as Record<string, unknown>;
    const methods: Record<string, number> = {};
    const properties: string[] = [];
    for (const name of Object.getOwnPropertyNames(proto).sort()) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
      if (descriptor.get) properties.push(name);
      else if (typeof descriptor.value === 'function')
        methods[name] = (descriptor.value as Function).length;
    }
    out[`${cls.meta.name}@${cls.meta.version}`] = {
      status: cls.meta.status,
      ...(cls.meta.removeIn ? { removeIn: cls.meta.removeIn } : {}),
      capability: cls.meta.capability ?? null,
      methods,
      properties
    };
  }
  return out;
}
