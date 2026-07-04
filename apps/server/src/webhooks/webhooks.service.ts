import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';

// H-3: Webhook bearer tokens are persisted as a SHA-256 hex digest. The
// plaintext is only ever held in memory long enough to return it from
// `createWebhookToken`; subsequent lookups hash the incoming bearer and
// query by `tokenHash`. Keeps a DB-read foothold from minting working
// triggers.
function hashWebhookToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

const WEBHOOK_RATE_WINDOW_MS = 60_000;
const WEBHOOK_RATE_MAX = 30;

@Injectable()
export class WebhooksService {
  private readonly triggerBuckets = new Map<
    string,
    { count: number; windowStart: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
  ) {}

  private enforceTriggerRateLimit(tokenId: string): void {
    const now = Date.now();
    const bucket = this.triggerBuckets.get(tokenId);

    if (!bucket || now - bucket.windowStart > WEBHOOK_RATE_WINDOW_MS) {
      this.triggerBuckets.set(tokenId, { count: 1, windowStart: now });
      return;
    }

    if (bucket.count >= WEBHOOK_RATE_MAX) {
      const retryAfter = Math.ceil(
        (bucket.windowStart + WEBHOOK_RATE_WINDOW_MS - now) / 1000,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Webhook rate limit exceeded (${WEBHOOK_RATE_MAX}/min). Try again in ${retryAfter}s.`,
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.count += 1;
  }

  async createWebhookToken(
    deploymentId: string,
    clerkId: string,
    label?: string,
    originatingApiTokenId?: string | null,
  ) {
    const user = await this.resolveUser(clerkId);

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'manage webhook tokens');

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashWebhookToken(token);

    const record = await this.prisma.deploymentWebhookToken.create({
      data: {
        deploymentId,
        // Persist only the hash; the plaintext column is retained nullable
        // for rollback safety but no new row populates it.
        token: null,
        tokenHash,
        label: label || null,
        createdByUserId: user.id,
        // H-3: tie the webhook's lifetime to the API token that minted it
        // (if any). Session-auth callers leave this NULL, in which case the
        // webhook lifetime is bound to the user + project-edit re-check.
        originatingApiTokenId: originatingApiTokenId ?? null,
      },
    });

    void this.audit.log({
      action: 'webhook_token.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'webhook_token',
      targetId: record.id,
      targetLabel: label || record.id,
    });

    return {
      id: record.id,
      // Return the plaintext from the in-memory variable — `record.token` is
      // NULL by design now that the column is no longer persisted.
      token,
      label: record.label,
      createdAt: record.createdAt,
    };
  }

  async listWebhookTokens(deploymentId: string, clerkId: string) {
    const user = await this.resolveUser(clerkId);

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'manage webhook tokens');

    return this.prisma.deploymentWebhookToken.findMany({
      where: { deploymentId },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteWebhookToken(
    deploymentId: string,
    tokenId: string,
    clerkId: string,
  ) {
    const user = await this.resolveUser(clerkId);

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'manage webhook tokens');

    const tokenRecord = await this.prisma.deploymentWebhookToken.findFirst({
      where: { id: tokenId, deploymentId },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Webhook token not found');
    }

    await this.prisma.deploymentWebhookToken.delete({
      where: { id: tokenId },
    });

    void this.audit.log({
      action: 'webhook_token.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'webhook_token',
      targetId: tokenId,
      targetLabel: tokenRecord.label || tokenId,
    });

    return { ok: true };
  }

  async triggerWebhookDeploy(
    rawToken: string,
    image?: string,
    tag?: string,
  ) {
    // H-3: look up by hash only. Plaintext-column lookup is gone — all
    // post-migration rows have token=NULL, and querying the legacy column
    // would defeat the at-rest hashing.
    const tokenRecord = await this.prisma.deploymentWebhookToken.findUnique({
      where: { tokenHash: hashWebhookToken(rawToken) },
      include: { deployment: { include: { project: true } } },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Invalid webhook token');
    }

    this.enforceTriggerRateLimit(tokenRecord.id);

    const deployment = tokenRecord.deployment;
    const organizationId = deployment.project.organizationId;
    const projectId = deployment.projectId;

    // Re-evaluate the token creator's access to this project on every trigger.
    // Without this, a member who created a webhook token and was later
    // demoted to viewer / removed from the project continues to mutate the
    // deployment through the token until it expires. The token is auto-
    // revoked on the first failed check so a stale CI hook can't keep
    // hammering the audit log.
    //
    // Legacy tokens with no `createdByUserId` cannot be RBAC-checked — there
    // is no principal to evaluate against. Previously these tokens bypassed
    // the re-check entirely, meaning any pre-RBAC token kept full mutation
    // power forever. Reject and purge them on first use.
    if (!tokenRecord.createdByUserId) {
      await this.prisma.deploymentWebhookToken
        .delete({ where: { id: tokenRecord.id } })
        .catch(() => {});
      void this.audit.log({
        action: 'deployment.webhook_triggered',
        actorUserId: null,
        organizationId,
        projectId,
        deploymentId: deployment.id,
        targetType: 'webhook_token',
        targetId: tokenRecord.id,
        targetLabel: tokenRecord.label ?? tokenRecord.id,
        metadata: { outcome: 'failure', action: 'rejected', reason: 'legacy_token_no_creator' },
      });
      throw new NotFoundException('Invalid webhook token');
    }

    // H-3: if this webhook was minted by an API token, that token must still
    // exist AND its restrictedProjectIds (if any) must still cover this
    // deployment's project. Otherwise revoking the API token would leave a
    // working trigger that bypasses the token's scope.
    if (tokenRecord.originatingApiTokenId) {
      const parent = await this.prisma.apiToken.findUnique({
        where: { id: tokenRecord.originatingApiTokenId },
        select: { id: true, restrictedProjectIds: true, expiresAt: true },
      });
      const parentValid =
        !!parent &&
        (!parent.expiresAt || parent.expiresAt > new Date()) &&
        (parent.restrictedProjectIds.length === 0 ||
          parent.restrictedProjectIds.includes(projectId));
      if (!parentValid) {
        await this.prisma.deploymentWebhookToken
          .delete({ where: { id: tokenRecord.id } })
          .catch(() => {});
        void this.audit.log({
          action: 'deployment.webhook_triggered',
          actorUserId: tokenRecord.createdByUserId,
          organizationId,
          projectId,
          deploymentId: deployment.id,
          targetType: 'webhook_token',
          targetId: tokenRecord.id,
          targetLabel: tokenRecord.label ?? tokenRecord.id,
          metadata: { outcome: 'failure', action: 'rejected', reason: 'originating_api_token_invalid' },
        });
        throw new NotFoundException('Invalid webhook token');
      }
    }

    try {
      await this.authz.requireProjectEdit(
        projectId,
        tokenRecord.createdByUserId,
        'trigger deployment via webhook',
      );
    } catch {
      await this.prisma.deploymentWebhookToken
        .delete({ where: { id: tokenRecord.id } })
        .catch(() => {});
      void this.audit.log({
        action: 'deployment.webhook_triggered',
        actorUserId: tokenRecord.createdByUserId,
        organizationId,
        projectId,
        deploymentId: deployment.id,
        targetType: 'webhook_token',
        targetId: tokenRecord.id,
        targetLabel: tokenRecord.label ?? tokenRecord.id,
        metadata: { outcome: 'failure', action: 'rejected', reason: 'creator_lost_access' },
      });
      throw new NotFoundException('Invalid webhook token');
    }

    // Update lastUsedAt (fire and forget)
    this.prisma.deploymentWebhookToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    const writeAudit = (
      outcome: 'success' | 'failure',
      action: string,
      extra?: Record<string, string | number | boolean | null>,
    ) => {
      void this.audit.log({
        action: 'deployment.webhook_triggered',
        actorUserId: tokenRecord.createdByUserId ?? null,
        organizationId,
        projectId,
        deploymentId: deployment.id,
        targetType: 'webhook_token',
        targetId: tokenRecord.id,
        targetLabel: tokenRecord.label ?? tokenRecord.id,
        metadata: {
          outcome,
          action,
          image: image ?? null,
          tag: tag ?? null,
          ...(extra ?? {}),
        },
      });
    };

    if (['building', 'deploying'].includes(deployment.status)) {
      writeAudit('failure', 'rejected', { reason: 'building' });
      throw new ConflictException(
        'Deployment is currently building, try again later',
      );
    }

    // Only allow image/tag updates for docker image deployments (not GitHub-based)
    if ((image || tag) && deployment.githubRepo) {
      writeAudit('failure', 'rejected', { reason: 'github_repo_image_update' });
      throw new BadRequestException(
        'Image updates via webhook are only supported for Docker image deployments. Use the rebuild endpoint for GitHub-based deployments.',
      );
    }

    if (image || tag) {
      const currentImage = deployment.image || '';
      const baseImage = image ?? currentImage.split(':')[0];
      const resolvedTag = tag ?? 'latest';
      const fullImage = `${baseImage}:${resolvedTag}`;

      try {
        await this.k8sWorkload.updateDeploymentImage(
          deployment.name,
          deployment.namespace,
          fullImage,
        );
      } catch (err) {
        writeAudit('failure', 'image-update', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Update DB
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { image: fullImage },
      });

      // Track in image history
      await this.prisma.$transaction(async (tx) => {
        await tx.imageHistory.updateMany({
          where: { deploymentId: deployment.id, isActive: true },
          data: { isActive: false },
        });

        await tx.imageHistory.create({
          data: {
            deploymentId: deployment.id,
            image: fullImage,
            tag: resolvedTag,
            isActive: true,
          },
        });

        // Prune old entries beyond 10
        const allImages = await tx.imageHistory.findMany({
          where: { deploymentId: deployment.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });

        if (allImages.length > 10) {
          const idsToRemove = allImages.slice(10).map((img) => img.id);
          await tx.imageHistory.deleteMany({
            where: { id: { in: idsToRemove } },
          });
        }
      });

      writeAudit('success', 'image-update', { fullImage });
      return {
        ok: true,
        deploymentId: deployment.id,
        action: 'image-update',
      };
    } 
      try {
        await this.k8sWorkload.restartDeployment(
          deployment.name,
          deployment.namespace,
        );
      } catch (err) {
        writeAudit('failure', 'restart', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      writeAudit('success', 'restart');
      return {
        ok: true,
        deploymentId: deployment.id,
        action: 'restart',
      };
    
  }

  private async resolveUser(clerkId: string) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

}
