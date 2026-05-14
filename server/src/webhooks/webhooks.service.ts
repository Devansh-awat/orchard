import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';
import * as crypto from 'crypto';

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

    const record = await this.prisma.deploymentWebhookToken.create({
      data: {
        deploymentId,
        token,
        label: label || null,
        createdByUserId: user.id,
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
      token: record.token,
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
    const tokenRecord = await this.prisma.deploymentWebhookToken.findUnique({
      where: { token: rawToken },
      include: { deployment: { include: { project: true } } },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Invalid webhook token');
    }

    this.enforceTriggerRateLimit(tokenRecord.id);

    // Update lastUsedAt (fire and forget)
    this.prisma.deploymentWebhookToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    const deployment = tokenRecord.deployment;
    const organizationId = deployment.project.organizationId;
    const projectId = deployment.projectId;

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
        await this.kubernetesService.updateDeploymentImage(
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
    } else {
      try {
        await this.kubernetesService.restartDeployment(
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
  }

  private async resolveUser(clerkId: string) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

}
