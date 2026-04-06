import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { UsersService } from '../users/users.service';
import * as crypto from 'crypto';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly usersService: UsersService,
  ) {}

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

    await this.verifyMembership(deployment.projectId, user.id);

    const token = crypto.randomBytes(32).toString('hex');

    const record = await this.prisma.deploymentWebhookToken.create({
      data: {
        deploymentId,
        token,
        label: label || null,
      },
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

    await this.verifyMembership(deployment.projectId, user.id);

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

    await this.verifyMembership(deployment.projectId, user.id);

    const tokenRecord = await this.prisma.deploymentWebhookToken.findFirst({
      where: { id: tokenId, deploymentId },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Webhook token not found');
    }

    await this.prisma.deploymentWebhookToken.delete({
      where: { id: tokenId },
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
      include: { deployment: true },
    });

    if (!tokenRecord) {
      throw new NotFoundException('Invalid webhook token');
    }

    // Update lastUsedAt (fire and forget)
    this.prisma.deploymentWebhookToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});

    const deployment = tokenRecord.deployment;

    if (['building', 'deploying'].includes(deployment.status)) {
      throw new ConflictException(
        'Deployment is currently building, try again later',
      );
    }

    // Only allow image/tag updates for docker image deployments (not GitHub-based)
    if ((image || tag) && deployment.githubRepo) {
      throw new BadRequestException(
        'Image updates via webhook are only supported for Docker image deployments. Use the rebuild endpoint for GitHub-based deployments.',
      );
    }

    if (image || tag) {
      const currentImage = deployment.image || '';
      const baseImage = image ?? currentImage.split(':')[0];
      const resolvedTag = tag ?? 'latest';
      const fullImage = `${baseImage}:${resolvedTag}`;

      await this.kubernetesService.updateDeploymentImage(
        deployment.name,
        deployment.namespace,
        fullImage,
      );

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

      return {
        ok: true,
        deploymentId: deployment.id,
        action: 'image-update',
      };
    } else {
      await this.kubernetesService.restartDeployment(
        deployment.name,
        deployment.namespace,
      );

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

  private async verifyMembership(projectId: string, userId: string) {
    const membership = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      include: { role: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    if (membership.role.name === 'viewer') {
      throw new ForbiddenException(
        'You do not have permission to manage webhook tokens',
      );
    }
  }
}
