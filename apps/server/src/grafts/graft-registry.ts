import type { DynamicModule, Type } from '@nestjs/common';
import type { ClassifiedRoute } from '../auth/route-classifier';
import type { ResolvedClaim } from './claims';
import type { GraftSignature } from './integrity';
import type { GraftManifest } from './manifest';

export type GraftPhase =
  | 'sync'
  | 'manifest'
  | 'integrity'
  | 'compat'
  | 'dependencies'
  | 'migrations'
  | 'load'
  | 'routes'
  | 'boot';

export type GraftRecord = {
  id: string;
  dir: string;
  status: 'loaded' | 'failed';
  phase?: GraftPhase;
  reason?: string;
  manifest?: GraftManifest;
  signature?: GraftSignature;
  claims?: ResolvedClaim[];
  routes?: ClassifiedRoute[];
  migrationsApplied?: string[];
  dbRole?: string | null;
  warnings: string[];
  module?: Type<unknown> | DynamicModule;
  uiDigest?: string;
};

const records: GraftRecord[] = [];

export function setGraftRecords(next: GraftRecord[]): void {
  records.splice(0, records.length, ...next);
}

export function graftRecords(): readonly GraftRecord[] {
  return records;
}

export function loadedGrafts(): GraftRecord[] {
  return records.filter((r) => r.status === 'loaded');
}

export function graftRecord(id: string): GraftRecord | undefined {
  return records.find((r) => r.id === id);
}

export function failGraft(record: GraftRecord, phase: GraftPhase, reason: string): void {
  record.status = 'failed';
  record.phase = phase;
  record.reason = reason;
  record.module = undefined;
}
