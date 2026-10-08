import * as http from 'http';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { execSessionEngine, type ExecRouteHooks } from '../kubernetes/exec-session-engine';
import type { SandboxExecTarget } from '../kubernetes/exec-sessions';
import { SandboxRunnerRegistry } from './runners/sandbox-runner.registry';
import { SANDBOX_REF_SELECT, refOf } from './runners/sandbox-runner';
import { SandboxAccessService } from './sandbox-access.service';
import { sandboxTerminalMode } from './sandbox-role-gate';
import {
  isTerminalIndex,
  isUuid,
  isWorktreePath,
  sandboxTerminalCommand
} from './sandbox-session-commands';

const ROUTE_RE = /^\/apiv1\/sandboxes\/([0-9a-f-]{36})\/terminal$/;

export interface SandboxTerminalQuery {
  sessionId: string | null;
  index: string;
  mode: 'rw' | 'ro';
}

export function parseSandboxTerminalQuery(params: URLSearchParams): SandboxTerminalQuery | null {
  const sid = params.get('sid');
  const n = params.get('n') || '0';
  const mode = params.get('mode');
  if (sid && !isUuid(sid)) return null;
  if (!isTerminalIndex(n)) return null;
  if (mode && mode !== 'rw' && mode !== 'ro') return null;
  if (!sid && n !== '0') return null;
  const scripted = n === 'setup' || n === 'run';
  return {
    sessionId: sid ? sid.toLowerCase() : null,
    index: n,
    mode: mode === 'rw' || mode === 'ro' ? mode : scripted ? 'ro' : 'rw'
  };
}

export function attachSandboxTerminalWebSocket(server: http.Server, app: INestApplication) {
  const prisma = app.get(PrismaService);
  const sessionsService = app.get(SessionsService);
  const audit = app.get(AuditService);
  const analytics = app.get(AnalyticsService);
  const settings = app.get(InstanceSettingsService);
  const registry = app.get(SandboxRunnerRegistry);
  const accessService = app.get(SandboxAccessService);

  const loadSession = async (sandboxId: string, sessionId: string) =>
    prisma.sandboxConversation.findFirst({
      where: { id: sessionId, sandboxId, archivedAt: null },
      select: { id: true, worktreePath: true }
    });

  const hooks: ExecRouteHooks = {
    route: ROUTE_RE,
    validate: (_match, url) =>
      parseSandboxTerminalQuery(url.searchParams) ? null : { reject: 400, message: 'Bad Request' },
    async preflight() {
      const enabled = await settings.isSandboxesEnabled().catch(() => false);
      return enabled ? null : { reject: 404, message: 'Not Found' };
    },
    async resolveTarget(match, url, auth) {
      const sandboxId = match[1].toLowerCase();
      const query = parseSandboxTerminalQuery(url.searchParams);
      if (!query || !isUuid(sandboxId)) return { reject: 400, message: 'Bad Request' };
      if (analytics.configured && !(await analytics.isFeatureEnabled('greenhouse', auth.userId))) {
        return { reject: 404, message: 'Not Found' };
      }
      const scope = {
        sessionOrgId: auth.sessionOrgScope ?? null,
        tokenProjectIds: auth.tokenAuthCtx?.tokenProjectIds ?? null
      };
      const access = await sandboxTerminalMode(
        accessService,
        sandboxId,
        auth.userId,
        query.mode,
        scope
      );
      if (!access) return { reject: 404, message: 'Not Found' };
      if (!query.sessionId && access.mode !== 'rw') return { reject: 403, message: 'Forbidden' };
      if (access.row.status !== 'running') return { reject: 404, message: 'Not Found' };
      let worktreePath: string | null = null;
      if (query.sessionId) {
        const session = await loadSession(sandboxId, query.sessionId);
        if (!session || !isWorktreePath(session.worktreePath)) {
          return { reject: 404, message: 'Not Found' };
        }
        worktreePath = session.worktreePath;
      }
      const target: SandboxExecTarget = {
        kind: 'sandbox',
        sandboxId,
        sessionId: query.sessionId,
        index: query.index,
        mode: access.mode,
        worktreePath
      };
      const principal = auth.userId;
      return {
        target,
        logAudit: (action, metadata = {}) => {
          audit
            .log({
              action,
              actorUserId: principal,
              actorEmail: auth.actorEmail ?? null,
              organizationId: access.row.organizationId ?? undefined,
              targetType: 'sandbox',
              targetId: sandboxId,
              targetLabel: access.row.name,
              metadata: {
                runner: access.row.runner,
                sessionId: query.sessionId,
                index: query.index,
                mode: access.mode,
                ...metadata
              }
            })
            .catch(() => {});
        },
        recheckAuth: async () => {
          try {
            if (auth.browserSessionId) {
              const valid = await sessionsService.validateSession(auth.browserSessionId);
              if (!valid) return false;
            }
            const again = await sandboxTerminalMode(
              accessService,
              sandboxId,
              principal,
              access.mode,
              scope
            );
            if (!again || again.mode !== access.mode) return false;
            if (again.row.status !== 'running') return false;
            if (query.sessionId && !(await loadSession(sandboxId, query.sessionId))) return false;
            return true;
          } catch {
            return false;
          }
        }
      };
    },
    async open(target, sessionId, size) {
      if (target.kind !== 'sandbox') throw new Error('not a sandbox target');
      const row = await prisma.sandbox.findUnique({
        where: { id: target.sandboxId },
        select: SANDBOX_REF_SELECT
      });
      if (!row) throw new Error('sandbox not found');
      const ref = refOf(row);
      return registry.for(ref).openPty(ref, {
        command: sandboxTerminalCommand(target, sessionId),
        cols: size.cols,
        rows: size.rows
      });
    },
    proxyPath(target) {
      if (target.kind !== 'sandbox') throw new Error('not a sandbox target');
      const params: Record<string, string> = { n: target.index, mode: target.mode };
      if (target.sessionId) params.sid = target.sessionId;
      return { path: `/apiv1/sandboxes/${target.sandboxId}/terminal`, params };
    },
    onActivity(target) {
      if (target.kind !== 'sandbox') return;
      prisma.sandbox
        .update({ where: { id: target.sandboxId }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
    },
    audit: {
      open: 'sandbox.terminal.open',
      reattach: 'sandbox.terminal.reattach',
      denied: 'sandbox.terminal.denied'
    },
    describeFailure: (message) => `Could not open a terminal in the sandbox: ${message}`
  };

  execSessionEngine(server, app).register(hooks);
}
