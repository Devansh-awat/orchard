import { Logger } from '@nestjs/common';
import { join } from 'node:path';
import { canUseName } from './claims';
import { failGraft, loadedGrafts, type GraftRecord } from './graft-registry';
import { loadGrafts } from './loader';

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

function guard(server: object, record: GraftRecord): object {
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
          return (value as (...args: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    }
  });
}

export function registerGraftMcpTools(server: object, client: unknown): void {
  for (const { record, register } of registrars) {
    try {
      register(guard(server, record), client, { graftId: record.id, apiBase: `/${record.id}` });
    } catch (err) {
      logger.error(`${record.id} failed to register MCP tools: ${(err as Error).message}`);
    }
  }
}
