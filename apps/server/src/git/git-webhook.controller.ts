import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeploymentsService } from '../projects/deployments.service';
import { autoDeployMatchesBranch } from '../github/auto-deploy-match';
import { partitionByWatchPaths } from '../github/watch-paths';
import { GitConnectionsService } from './git-connections.service';
import { repoUrlVariantsFor, type PushEvent, type WebhookHeaders } from './git-provider';

/**
 * One URL per connection. The secret belonging to that connection is the
 * only thing that can authenticate a delivery, and a delivery can only reach
 * deployments on that same connection, so no forge can speak for another
 * tenant's repo however its payload is shaped.
 */
@Controller('git/webhooks')
export class GitWebhookController {
  private readonly logger = new Logger(GitWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GitConnectionsService,
    private readonly deployments: DeploymentsService,
    private readonly authz: AuthorizationService
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @HttpCode(200)
  @Post(':connectionId')
  async receive(
    @Param('connectionId') connectionId: string,
    @Headers() headers: WebhookHeaders,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown
  ) {
    const row = await this.prisma.gitConnection.findUnique({ where: { id: connectionId } });
    if (!row) throw new UnauthorizedException('Unknown webhook');
    const provider = await this.connections.providerForRow(row);
    const rawBody = req.rawBody?.toString() || JSON.stringify(body ?? {});
    if (!provider.verifyWebhook(rawBody, headers)) {
      throw new UnauthorizedException('Invalid signature');
    }
    const push = provider.parsePush(headers, body);
    if (!push) return { received: true, action: 'ignored', reason: 'not a push' };
    return this.dispatch(row.id, push);
  }

  async dispatch(connectionId: string, push: PushEvent) {
    if (push.deleted || !push.commitSha) {
      return { received: true, action: 'ignored', reason: 'no commit to deploy' };
    }
    const byUrl = { githubRepo: { in: repoUrlVariantsFor(push.repoUrl) } };
    const rows = await this.prisma.deployment.findMany({
      where: {
        gitConnectionId: connectionId,
        autoDeployEnabled: true,
        ...(push.externalRepoId
          ? { OR: [{ ...byUrl, externalRepoId: null }, { externalRepoId: push.externalRepoId }] }
          : byUrl)
      }
    });
    const onBranch = rows.filter((d) => autoDeployMatchesBranch(d, push.branch));
    if (onBranch.length === 0) {
      return {
        received: true,
        action: 'ignored',
        reason: `no auto-deploy deployments for ${push.repoFullName}:${push.branch}`
      };
    }
    if (push.externalRepoId) {
      const stale = onBranch.filter((d) => d.externalRepoId !== push.externalRepoId);
      if (stale.length > 0) {
        await this.prisma.deployment.updateMany({
          where: { id: { in: stale.map((d) => d.id) } },
          data: { externalRepoId: push.externalRepoId }
        });
      }
    }
    const { watched: pathMatched } = partitionByWatchPaths(onBranch, push.changedFiles);
    const skipped = onBranch.length - pathMatched.length;
    if (pathMatched.length === 0) {
      return { received: true, action: 'ignored', reason: 'no watched paths changed', skipped };
    }
    const connection = await this.prisma.gitConnection.findUnique({
      where: { id: connectionId },
      select: { userId: true }
    });
    const editable = new Map<string, boolean>();
    const watched: typeof pathMatched = [];
    for (const d of pathMatched) {
      if (!editable.has(d.projectId)) {
        const access = connection
          ? await this.authz.getProjectAccess(d.projectId, connection.userId)
          : null;
        editable.set(d.projectId, Boolean(access?.canEdit));
      }
      if (editable.get(d.projectId)) watched.push(d);
      else {
        this.logger.warn(
          `skipping auto-deploy of ${d.id}: git connection ${connectionId} owner no longer has edit access to project ${d.projectId}`
        );
      }
    }
    if (watched.length === 0) {
      return {
        received: true,
        action: 'ignored',
        reason: 'connection owner no longer has access',
        skipped: onBranch.length
      };
    }
    const results = await Promise.allSettled(
      watched.map((d) =>
        this.deployments.triggerAutoDeploy(
          d.id,
          push.commitSha!,
          push.message,
          push.authorName ?? undefined,
          push.authorUsername ?? undefined
        )
      )
    );
    return {
      received: true,
      action: 'deploying',
      commit: push.commitSha.slice(0, 7),
      deployments: {
        total: onBranch.length,
        triggered: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
        skipped
      }
    };
  }
}
