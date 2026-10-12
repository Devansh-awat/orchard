import { Logger, type DynamicModule, type INestApplication, type Type } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { resolve, sep } from 'node:path';
import { activeClaims } from './claims';
import { failGraft, loadedGrafts, type GraftRecord } from './graft-registry';

const logger = new Logger('Grafts');

function graftClassNames(record: GraftRecord): string[] {
  const root = resolve(record.dir) + sep;
  const names = new Set<string>();
  for (const [file, cached] of Object.entries(require.cache)) {
    if (!file.startsWith(root) || !cached?.exports) continue;
    const exports = cached.exports as Record<string, unknown>;
    for (const value of [exports, ...Object.values(exports)]) {
      if (typeof value === 'function' && value.name && value.name.length > 3) names.add(value.name);
    }
  }
  return [...names];
}

function blame(err: unknown, candidates: GraftRecord[]): GraftRecord[] {
  const text = `${(err as Error)?.message ?? ''}\n${(err as Error)?.stack ?? ''}`;
  const byFile = candidates.filter((r) => text.includes(resolve(r.dir) + sep));
  if (byFile.length) return byFile;
  return candidates.filter((r) =>
    graftClassNames(r).some((name) => new RegExp(`\\b${name}\\b`).test(text))
  );
}

export async function createWithGrafts<T>(
  create: (grafts: GraftRecord[]) => Promise<T>
): Promise<T> {
  for (;;) {
    const grafts = loadedGrafts();
    try {
      return await create(grafts);
    } catch (err) {
      if (grafts.length === 0) throw err;
      const culprits = blame(err, grafts);
      const failing = culprits.length ? culprits : grafts;
      const message = (err as Error)?.message ?? String(err);
      for (const record of failing) failGraft(record, 'boot', message);
      logger.error(
        `booting with grafts failed (${message}); retrying without ${failing.map((r) => r.id).join(', ')}`
      );
      if (process.env.ORCHARD_GRAFTS_STRICT === '1' || process.env.ORCHARD_GRAFTS_STRICT === 'true')
        throw err;
    }
  }
}

type Layer = {
  route?: { path?: string; methods?: Record<string, boolean> };
  match: (path: string) => boolean;
};

export function installApiAliases(app: INestApplication, globalPrefix = 'apiv1'): void {
  const aliases = loadedGrafts().flatMap((record) =>
    activeClaims(record.claims, 'apiAliases').map((alias) => ({ id: record.id, alias }))
  );
  if (aliases.length === 0) return;
  const graftPrefixes = loadedGrafts().map((r) => `/${globalPrefix}/${r.id}`);
  const express = app.getHttpAdapter().getInstance() as { router?: { stack: Layer[] } };
  let coreLayers: Layer[] | null = null;
  const isGraftRoute = (path: string) =>
    graftPrefixes.some((p) => path === p || path.startsWith(`${p}/`));
  const coreHandles = (path: string, method: string) => {
    coreLayers ??= (express.router?.stack ?? []).filter(
      (l) => l.route?.path && !isGraftRoute(l.route.path)
    );
    return coreLayers.some((l) => {
      const methods = l.route?.methods ?? {};
      return (methods._all || methods[method.toLowerCase()]) && l.match(path);
    });
  };
  app.use(
    (req: { url: string; method: string; path?: string }, _res: unknown, next: () => void) => {
      const path = (req.url.split('?')[0] ?? '').replace(/\/+$/, '');
      for (const { id, alias } of aliases) {
        const base = `/${globalPrefix}/${alias}`;
        if (path !== base && !path.startsWith(`${base}/`)) continue;
        if (coreHandles(path, req.method)) break;
        req.url = `/${globalPrefix}/${id}${req.url.slice(globalPrefix.length + 1)}`;
        break;
      }
      next();
    }
  );
}

export function graftImports(grafts: GraftRecord[]): (Type<unknown> | DynamicModule)[] {
  const mounted = grafts.filter((g) => g.module);
  const moduleOf = (g: GraftRecord) =>
    typeof g.module === 'function' ? g.module : (g.module as DynamicModule).module;
  return [
    ...mounted.map((g) => g.module as Type<unknown> | DynamicModule),
    RouterModule.register(mounted.map((g) => ({ path: g.id, module: moduleOf(g) })))
  ];
}
