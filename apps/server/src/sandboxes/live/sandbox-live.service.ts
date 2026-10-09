import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionsService } from '../../auth/sessions.service';
import { requestAuthStorage } from '../../auth/request-context';
import { SandboxRunnerRegistry } from '../runners/sandbox-runner.registry';
import { SandboxAccessService, SandboxRole } from '../sandbox-access.service';
import { SandboxSessionsService } from '../sandbox-sessions.service';
import { normalizeRelativePath } from '../sandbox-session-commands';
import { LiveBackend, createLiveBackend } from './live-backend';
import { SandboxLiveHub } from './live-hub';
import { YRoomManager } from './yjs-rooms';
import { SandboxYRoomFiles } from './yjs-files';

export interface LiveCommentInput {
  sandboxId: string;
  userId: string;
  sid: string;
  chatId: string;
  body: string;
}

export type LiveCommentSink = (input: LiveCommentInput) => Promise<unknown>;

@Injectable()
export class SandboxLiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SandboxLiveService.name);

  readonly backend: LiveBackend;

  readonly hub: SandboxLiveHub;

  readonly rooms: YRoomManager;

  private commentSink: LiveCommentSink | null = null;

  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionsAuth: SessionsService,
    private readonly access: SandboxAccessService,
    private readonly registry: SandboxRunnerRegistry,
    private readonly sessions: SandboxSessionsService
  ) {
    const warn = (message: string) => this.logger.warn(message);
    this.backend = createLiveBackend(warn);
    if (!this.backend.shared) {
      this.logger.warn(
        'REDIS_URL is not set: live presence and collaborative editing only reach people on this server replica'
      );
    }
    this.hub = new SandboxLiveHub({
      backend: this.backend,
      rooms: null,
      resolveRole: (sandboxId, userId, orgScope) => this.resolveRole(sandboxId, userId, orgScope),
      validateSession: (sessionId) => this.sessionsAuth.validateSession(sessionId),
      sessionBelongs: async (sandboxId, sid) =>
        (await this.prisma.sandboxConversation.count({ where: { id: sid, sandboxId } })) > 0,
      postComment: async (input) => {
        if (!this.commentSink) throw new Error('Comments are unavailable right now');
        return this.commentSink(input);
      },
      normalizePath: (value) => normalizeRelativePath(value),
      warn
    });
    this.rooms = new YRoomManager(
      this.backend,
      {
        replicaId: this.backend.replicaId,
        deliverLocal: (connId, frame) => this.hub.deliverLocal(connId, frame),
        publish: (sandboxId, envelope) => this.hub.publishY(sandboxId, envelope)
      },
      new SandboxYRoomFiles(this.prisma, this.registry),
      {},
      warn
    );
    this.hub.setRooms(this.rooms);
  }

  onModuleInit() {
    this.unsubscribers.push(
      this.sessions.onSessionChanged((sandboxId, session) => {
        this.broadcast(sandboxId, { t: 'session', session }).catch(() => {});
      }),
      this.sessions.onSessionDeleted((sandboxId, sessionId) => {
        this.broadcast(sandboxId, { t: 'session-deleted', id: sessionId }).catch(() => {});
      })
    );
  }

  async onModuleDestroy() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.hub.close().catch(() => {});
    await this.rooms.close().catch(() => {});
    await this.backend.close().catch(() => {});
  }

  setCommentSink(sink: LiveCommentSink) {
    this.commentSink = sink;
  }

  async resolveRole(
    sandboxId: string,
    userId: string,
    orgScope: string | null
  ): Promise<SandboxRole | null> {
    const resolved = await requestAuthStorage.run(orgScope ? { sessionOrgId: orgScope } : {}, () =>
      this.access.resolveInside(sandboxId, userId)
    );
    if (!resolved) return null;
    if (resolved.sandbox.desiredState === 'deleted') return null;
    return resolved.role;
  }

  async broadcast(sandboxId: string, frame: Record<string, unknown>) {
    await this.hub.broadcast(sandboxId, frame);
  }

  async aclChanged(sandboxId: string, userId: string | null = null) {
    await this.hub.aclChanged(sandboxId, userId);
  }

  async connectedUserIds(sandboxId: string, sid: string | null = null): Promise<Set<string>> {
    return this.hub.connectedUserIds(sandboxId, sid);
  }
}
