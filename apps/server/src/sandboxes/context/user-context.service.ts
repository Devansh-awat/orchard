import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { UserContextItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../crypto/secret-crypto.service';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { refOf } from '../runners/sandbox-runner';
import { SandboxWorkspaceService, type WorkspaceSandbox } from '../sandbox-workspace.service';
import { shellQuote } from '../sandbox-session-commands';
import {
  CONTEXT_HOME,
  CONTEXT_LIMITS,
  CONTEXT_MANIFEST,
  ContextValidationError,
  OPENCODE_USER_CONFIG,
  boxFilesFor,
  mcpSecretKeys,
  opencodeUserConfig,
  payloadBytes,
  validateContextItem,
  type ContextItemInput,
  type ContextKind,
  type ContextPayload
} from './user-context';

export interface ContextItemDto {
  id: string;
  kind: ContextKind;
  name: string;
  enabled: boolean;
  sizeBytes: number;
  lock: string;
  secretKeys: string[];
  updatedAt: Date;
}

export interface ContextItemDetailDto extends ContextItemDto {
  files?: Record<string, string>;
  mcp?: ContextPayload['mcp'];
}

export interface ContextSyncResult {
  sandboxId: string;
  files: number;
  changed: boolean;
  reloaded: boolean;
}

const MANAGED_PREFIXES = [
  `${CONTEXT_HOME}/.claude/CLAUDE.md`,
  `${CONTEXT_HOME}/.claude/agents/`,
  `${CONTEXT_HOME}/.claude/commands/`,
  `${CONTEXT_HOME}/.claude/skills/`,
  `${CONTEXT_HOME}/.config/opencode/agent/`,
  `${CONTEXT_HOME}/.config/opencode/command/`,
  OPENCODE_USER_CONFIG
];

function managed(path: string): boolean {
  return !path.includes('/../') && MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

@Injectable()
export class UserContextService {
  private readonly logger = new Logger(UserContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly workspace: SandboxWorkspaceService
  ) {}

  private payloadOf(row: UserContextItem): ContextPayload {
    return JSON.parse(this.crypto.decryptForUser(row.userId, row.payload)) as ContextPayload;
  }

  private toDto(row: UserContextItem, payload?: ContextPayload): ContextItemDto {
    const mcp = row.kind === 'mcp' ? (payload ?? this.payloadOf(row)).mcp : undefined;
    return {
      id: row.id,
      kind: row.kind as ContextKind,
      name: row.name,
      enabled: row.enabled,
      sizeBytes: row.sizeBytes,
      lock: row.lock,
      secretKeys: mcp ? mcpSecretKeys(mcp) : [],
      updatedAt: row.updatedAt
    };
  }

  private validate(raw: unknown): ContextItemInput {
    try {
      return validateContextItem((raw ?? {}) as Record<string, unknown>);
    } catch (e) {
      if (e instanceof ContextValidationError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  async list(userId: string): Promise<{ items: ContextItemDto[] }> {
    const rows = await this.prisma.userContextItem.findMany({
      where: { userId },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }]
    });
    return { items: rows.map((row) => this.toDto(row)) };
  }

  async get(userId: string, id: string): Promise<ContextItemDetailDto> {
    const row = await this.prisma.userContextItem.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Context item not found');
    const payload = this.payloadOf(row);
    return { ...this.toDto(row, payload), ...payload };
  }

  private async checkQuota(userId: string, incoming: ContextItemInput[]) {
    const rows = await this.prisma.userContextItem.findMany({
      where: { userId },
      select: { kind: true, name: true, sizeBytes: true }
    });
    const sizes = new Map(rows.map((row) => [`${row.kind}/${row.name}`, row.sizeBytes]));
    for (const item of incoming) {
      const bytes = payloadBytes(item.payload);
      if (bytes > CONTEXT_LIMITS.itemBytes) {
        throw new BadRequestException(`${item.kind}/${item.name} is larger than 1 MB`);
      }
      sizes.set(`${item.kind}/${item.name}`, bytes);
    }
    if (sizes.size > CONTEXT_LIMITS.items) {
      throw new BadRequestException(`You can keep at most ${CONTEXT_LIMITS.items} context items`);
    }
    const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (total > CONTEXT_LIMITS.userBytes) {
      throw new BadRequestException('Your context is larger than 5 MB in total');
    }
  }

  private async write(userId: string, item: ContextItemInput): Promise<UserContextItem> {
    const payload = this.crypto.encryptForUser(userId, JSON.stringify(item.payload));
    const sizeBytes = payloadBytes(item.payload);
    return this.prisma.userContextItem.upsert({
      where: { userId_kind_name: { userId, kind: item.kind, name: item.name } },
      create: { userId, kind: item.kind, name: item.name, payload, sizeBytes },
      update: { payload, sizeBytes }
    });
  }

  async upsert(userId: string, raw: unknown): Promise<ContextItemDto> {
    const item = this.validate(raw);
    await this.checkQuota(userId, [item]);
    const row = await this.write(userId, item);
    this.syncSoon(userId);
    return this.toDto(row, item.payload);
  }

  async import(
    userId: string,
    raw: unknown
  ): Promise<{ imported: number; items: ContextItemDto[] }> {
    const list = (raw as { items?: unknown } | null)?.items;
    if (!Array.isArray(list) || list.length === 0) {
      throw new BadRequestException('items must be a non-empty list');
    }
    if (list.length > CONTEXT_LIMITS.items) {
      throw new BadRequestException(`At most ${CONTEXT_LIMITS.items} items per import`);
    }
    const items = list.map((entry) => this.validate(entry));
    await this.checkQuota(userId, items);
    const rows: ContextItemDto[] = [];
    for (const item of items) rows.push(this.toDto(await this.write(userId, item), item.payload));
    this.syncSoon(userId);
    return { imported: rows.length, items: rows };
  }

  async setEnabled(userId: string, id: string, enabled: boolean): Promise<ContextItemDto> {
    const found = await this.prisma.userContextItem.findFirst({ where: { id, userId } });
    if (!found) throw new NotFoundException('Context item not found');
    const row = await this.prisma.userContextItem.update({ where: { id }, data: { enabled } });
    this.syncSoon(userId);
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<{ success: true }> {
    const deleted = await this.prisma.userContextItem.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) throw new NotFoundException('Context item not found');
    this.syncSoon(userId);
    return { success: true };
  }

  private async enabledItems(userId: string): Promise<ContextItemInput[]> {
    const rows = await this.prisma.userContextItem.findMany({
      where: { userId, enabled: true, lock: 'server' },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }]
    });
    return rows.map((row) => ({
      kind: row.kind as ContextKind,
      name: row.name,
      payload: this.payloadOf(row)
    }));
  }

  private syncSoon(userId: string) {
    void this.syncOwnedMachines(userId).catch((e) =>
      this.logger.warn(`context sync for ${userId} failed: ${e?.message}`)
    );
  }

  async syncOwnedMachines(userId: string): Promise<ContextSyncResult[]> {
    const machines = await this.prisma.sandbox.findMany({
      where: { userId, status: 'running' }
    });
    const results: ContextSyncResult[] = [];
    for (const machine of machines) {
      try {
        results.push(await this.syncToSandbox(machine as unknown as WorkspaceSandbox));
      } catch (e: any) {
        this.logger.warn(`context sync to ${machine.id} failed: ${e?.message}`);
      }
    }
    return results;
  }

  async syncToSandbox(sandbox: WorkspaceSandbox): Promise<ContextSyncResult> {
    if (sandbox.status !== 'running') {
      return { sandboxId: sandbox.id, files: 0, changed: false, reloaded: false };
    }
    const items = await this.enabledItems(sandbox.userId);
    const { files, mcp } = boxFilesFor(items);
    files[OPENCODE_USER_CONFIG] = opencodeUserConfig(mcp);
    const paths = Object.keys(files).sort();
    const hash = createHash('sha256')
      .update(JSON.stringify(paths.map((path) => [path, files[path]])))
      .digest('hex');
    const runner = this.registry.for(sandbox);
    const ref = refOf(sandbox);
    const previous = await this.readManifest(sandbox);
    if (previous?.hash === hash) {
      return { sandboxId: sandbox.id, files: paths.length, changed: false, reloaded: false };
    }
    const stale = (previous?.paths ?? []).filter((path) => managed(path) && !(path in files));
    if (stale.length > 0) {
      const removal = `rm -f -- ${stale.map(shellQuote).join(' ')}`;
      await runner.exec(ref, ['su', '-l', 'dev', '-c', removal]);
    }
    await runner.writeFiles(
      ref,
      [
        ...paths.map((path) => ({ path, content: Buffer.from(files[path], 'utf8') })),
        {
          path: CONTEXT_MANIFEST,
          content: Buffer.from(JSON.stringify({ hash, paths }), 'utf8')
        }
      ],
      { asUser: 'dev' }
    );
    const reloaded = await this.reloadWhenIdle(sandbox);
    return { sandboxId: sandbox.id, files: paths.length, changed: true, reloaded };
  }

  private async readManifest(
    sandbox: WorkspaceSandbox
  ): Promise<{ hash: string; paths: string[] } | null> {
    const result = await this.registry
      .for(sandbox)
      .exec(refOf(sandbox), [
        'su',
        '-l',
        'dev',
        '-c',
        `cat ${shellQuote(CONTEXT_MANIFEST)} 2>/dev/null`
      ]);
    if (!result.ok || !result.stdout.trim()) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { hash?: unknown; paths?: unknown };
      if (typeof parsed.hash !== 'string' || !Array.isArray(parsed.paths)) return null;
      return {
        hash: parsed.hash,
        paths: parsed.paths.filter((p): p is string => typeof p === 'string')
      };
    } catch {
      return null;
    }
  }

  private async reloadWhenIdle(sandbox: WorkspaceSandbox): Promise<boolean> {
    try {
      const sessions = await this.prisma.sandboxConversation.findMany({
        where: { sandboxId: sandbox.id, archivedAt: null, worktreePath: { not: null } },
        select: { worktreePath: true }
      });
      const directories = [null, ...sessions.map((s) => s.worktreePath)];
      for (const directory of directories) {
        const res = await this.workspace.opencodeRequest(sandbox, 'GET', '/session/status', {
          directory,
          timeoutMs: 5000
        });
        if (res.status !== 200) return false;
        const busy = Object.values((res.body ?? {}) as Record<string, { type?: string }>).some(
          (value) => value?.type === 'busy' || value?.type === 'retry'
        );
        if (busy) return false;
      }
      const res = await this.workspace.opencodeRequest(sandbox, 'POST', '/global/dispose', {
        timeoutMs: 10_000
      });
      return res.status >= 200 && res.status < 300;
    } catch (e: any) {
      this.logger.warn(`could not reload the agent in ${sandbox.id}: ${e?.message}`);
      return false;
    }
  }
}
