import * as http from 'http';
import type * as net from 'net';
import type WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { SessionsService } from '../auth/sessions.service';
import { AuditService } from '../audit/audit.service';
import { requestAuthStorage } from '../auth/request-context';
import { resolveNamespaceScope } from '../projects/namespace-scope';
import type { PtyHandle } from './pty';
import { loadKubeConfigFromPathOrBase64 } from './kubeconfig';
import { ResizableOutput, isPodTarget, type PodExecTarget } from './exec-sessions';
import { execSessionEngine, type ExecRouteHooks } from './exec-session-engine';

function describeExecFailure(message: string): string {
  if (/failed to load \/bin\/sh|no such file or directory/i.test(message)) {
    return 'This image has no shell, so an interactive session is not possible.';
  }
  if (/not found|NotFound/i.test(message)) {
    return 'That container is no longer running.';
  }
  return `Could not start a shell: ${message}`;
}

function shellCommand(sessionId: string): string[] {
  return [
    '/bin/sh',
    '-c',
    'export TERM=xterm-256color COLORTERM=truecolor; ' +
      `if command -v tmux >/dev/null 2>&1; then exec tmux -u new-session -A -s "orchard-${sessionId}"; fi; ` +
      'for s in bash zsh sh ash dash; do ' +
      'if command -v "$s" >/dev/null 2>&1; then exec "$s"; fi; done; exec sh'
  ];
}

export function podPty(
  kc: k8s.KubeConfig,
  target: Pick<PodExecTarget, 'namespace' | 'podName' | 'container'>,
  command: string[],
  size: { cols: number; rows: number }
): PtyHandle {
  const stdin = new PassThrough();
  const stdout = new ResizableOutput();
  stdout.setSize(size.cols, size.rows);
  const stderr = new PassThrough();
  stderr.on('data', (chunk: Buffer) => stdout.write(chunk));
  let upstream: WebSocket | null = null;
  let closed = false;
  let resolveExit!: (value: { ok: boolean; message: string | null }) => void;
  const exited = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  new k8s.Exec(kc)
    .exec(
      target.namespace,
      target.podName,
      target.container,
      command,
      stdout,
      stderr,
      stdin,
      true,
      (status) => {
        if (status.status === 'Success') {
          resolveExit({ ok: true, message: null });
          return;
        }
        resolveExit({ ok: false, message: status.message ?? '' });
      }
    )
    .then((up) => {
      const socket = up as unknown as WebSocket;
      if (closed) {
        try {
          socket.close();
        } catch {}
        return;
      }
      upstream = socket;
      const raw = (socket as unknown as { _socket?: net.Socket })._socket;
      raw?.setNoDelay?.(true);
      socket.on('close', () => resolveExit({ ok: true, message: null }));
    })
    .catch((err) => {
      resolveExit({ ok: false, message: err?.message ?? 'exec failed' });
    });
  return {
    stdin,
    output: stdout,
    resize: (cols, rows) => stdout.setSize(cols, rows),
    pause: () => (upstream ?? stdout).pause(),
    resume: () => (upstream ?? stdout).resume(),
    close: () => {
      closed = true;
      try {
        upstream?.close();
      } catch {}
    },
    exited
  };
}

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const base64Value = process.env.KUBECONFIG_BASE64;
  const configPath = process.env.KUBECONFIG_PATH || process.env.KUBECONFIG;
  try {
    if (base64Value) {
      kc.loadFromString(Buffer.from(base64Value, 'base64').toString('utf-8'));
    } else if (configPath) {
      loadKubeConfigFromPathOrBase64(kc, configPath);
    } else {
      kc.loadFromDefault();
    }
  } catch (err) {
    console.warn(
      '[Terminal] kubeconfig unavailable — pod exec terminal disabled:',
      (err as Error).message
    );
  }
  return kc;
}

export function attachTerminalWebSocket(server: http.Server, app: INestApplication) {
  const prisma = app.get(PrismaService);
  const authz = app.get(AuthorizationService);
  const sessionsService = app.get(SessionsService);
  const audit = app.get(AuditService);
  const kc = loadKubeConfig();

  const hooks: ExecRouteHooks = {
    route: /^\/apiv1\/pods\/([^/]+)\/exec$/,
    validate: (_match, url) =>
      url.searchParams.get('namespace') ? null : { reject: 400, message: 'Bad Request' },
    async resolveTarget(match, url, auth) {
      const podName = match[1];
      const namespace = url.searchParams.get('namespace') || '';
      const container = url.searchParams.get('container') || '';
      const principal = auth.userId;
      const scope = await resolveNamespaceScope(prisma, namespace);
      if (!scope) return { reject: 404, message: 'Not Found' };
      const project = { id: scope.projectId, organizationId: scope.organizationId };
      const runWithAuthCtx = <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, rejectPromise) => {
          requestAuthStorage.run(
            auth.tokenAuthCtx ?? { sessionOrgId: auth.sessionOrgScope },
            () => {
              fn().then(resolve, rejectPromise);
            }
          );
        });
      try {
        await runWithAuthCtx(() =>
          authz.requireProjectEdit(project.id, principal, 'exec into pod')
        );
      } catch {
        return { reject: 404, message: 'Not Found' };
      }
      const target: PodExecTarget = {
        kind: 'pod',
        namespace,
        podName,
        container,
        projectId: project.id,
        organizationId: project.organizationId
      };
      return {
        target,
        logAudit: (action, metadata = {}) => {
          audit
            .log({
              action,
              actorUserId: principal,
              actorEmail: auth.actorEmail ?? null,
              organizationId: project.organizationId,
              projectId: project.id,
              targetType: 'pod',
              targetId: podName,
              targetLabel: podName,
              metadata: { namespace, container: container || null, ...metadata }
            })
            .catch(() => {});
        },
        recheckAuth: () =>
          runWithAuthCtx(async () => {
            try {
              if (auth.browserSessionId) {
                const valid = await sessionsService.validateSession(auth.browserSessionId);
                if (!valid) return false;
              }
              await authz.requireProjectEdit(project.id, principal, 'exec into pod');
              return true;
            } catch {
              return false;
            }
          })
      };
    },
    open(target, sessionId, size) {
      if (!isPodTarget(target)) throw new Error('not a pod target');
      return podPty(kc, target, shellCommand(sessionId), size);
    },
    proxyPath(target) {
      if (!isPodTarget(target)) throw new Error('not a pod target');
      return {
        path: `/apiv1/pods/${encodeURIComponent(target.podName)}/exec`,
        params: { namespace: target.namespace, container: target.container }
      };
    },
    audit: {
      open: 'deployment.pod.exec',
      reattach: 'deployment.pod.exec.reattach',
      denied: 'deployment.pod.exec.denied'
    },
    describeFailure: describeExecFailure
  };

  execSessionEngine(server, app).register(hooks);
}
