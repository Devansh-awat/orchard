import { Logger } from '@nestjs/common';
import { join } from 'node:path';
import { canUseName } from './claims';
import { failGraft, loadedGrafts, type GraftRecord } from './graft-registry';
import { loadGrafts } from './loader';
import { graftToolScope, scopeAllows } from '../mcp/catalog';
import type { McpScope } from '../mcp/client';

type Registrar = (
  server: unknown,
  client: unknown,
  context: { graftId: string; apiBase: string }
) => void;

const logger = new Logger('Grafts');
const registrars: { record: GraftRecord; register: Registrar }[] = [];

export async function loadMcpGrafts(): Promise<void> {
  await loadGrafts({ migrate: false, server: false });
  registrars.length = 0;
  for (const record of loadedGrafts()) {
    const entry = record.manifest!.entries.mcp;
    if (!entry) continue;
    try {
      if (!record.manifest!.capabilities.includes('mcp')) {
        throw new Error('graft.json has an mcp entry but does not declare the "mcp" capability');
      }
      const exported = require(join(record.dir, entry)) as Record<string, unknown>;
      const candidate = (exported.default ?? exported) as Registrar | { register?: Registrar };
      const register = typeof candidate === 'function' ? candidate : candidate?.register;
      if (typeof register !== 'function')
        throw new Error(`${entry} must export register(server, client)`);
      registrars.push({ record, register });
    } catch (err) {
      failGraft(record, 'load', (err as Error).message);
      logger.error(`${record.id} mcp entry failed: ${(err as Error).message}`);
    }
  }
}

function guard(server: object, record: GraftRecord, scope: McpScope): object {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'registerTool' || prop === 'tool') {
        return (name: string, ...rest: unknown[]) => {
          if (!canUseName(record.id, record.claims, 'mcpTools', name)) {
            throw new Error(
              `graft ${record.id} registered MCP tool "${name}" outside its namespace; claim it in mcpTools`
            );
          }
          const config = prop === 'registerTool' ? rest[0] : undefined;
          if (!scopeAllows(scope, graftToolScope(config))) return undefined;
          return (value as (...args: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    }
  });
}

export function flagGatedMcpGrafts(): string[] {
  return registrars
    .filter(({ record }) => record.manifest!.capabilities.includes('flags'))
    .map(({ record }) => record.id);
}

export async function graftsHiddenFrom(
  graftIds: string[],
  userId: string | null,
  isEnabled: (flag: string, userId: string) => Promise<boolean>
): Promise<Set<string>> {
  if (!userId) return new Set(graftIds);
  const enabled = await Promise.all(graftIds.map((id) => isEnabled(id, userId).catch(() => false)));
  return new Set(graftIds.filter((_, index) => !enabled[index]));
}

export function registerGraftMcpTools(
  server: object,
  client: unknown,
  include: (graftId: string) => boolean = () => true,
  scope: McpScope = 'exec'
): void {
  for (const { record, register } of registrars) {
    if (!include(record.id)) continue;
    try {
      register(guard(server, record, scope), client, {
        graftId: record.id,
        apiBase: `/${record.id}`
      });
    } catch (err) {
      logger.error(`${record.id} failed to register MCP tools: ${(err as Error).message}`);
    }
  }
}
