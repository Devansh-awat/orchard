import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import { onEnvironmentEnvChanged, type EnvironmentEnvChange } from '../../env/env-change-signal';
import { PrismaService } from '../../prisma/prisma.service';
import type { DeploymentsService } from '../../projects/deployments.service';
import type { EnvironmentsService } from '../../projects/environments.service';
import type { IngressService } from '../../projects/ingress.service';
import type { GraftRecord } from '../graft-registry';
import { bindGraft, type DoorMeta } from './door';

type CreateFromGitHub = DeploymentsService['createDeploymentFromGitHub'];
type Rebuild = DeploymentsService['rebuildDeployment'];
type CreateEnvironment = EnvironmentsService['createEnvironment'];
type DeleteEnvironment = EnvironmentsService['deleteEnvironment'];
type DeleteFromCluster = EnvironmentsService['deleteEnvironmentFromCluster'];
type AutoIngress = IngressService['createAutoIngressForDeployment'];

@Injectable({ scope: Scope.TRANSIENT })
export class ProjectsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'projects',
    version: 1,
    status: 'stable',
    capability: 'projects.read'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {
    this.graft = bindGraft(parent, ProjectsDoorV1.meta);
  }

  onEnvironmentEnvChanged(listener: (change: EnvironmentEnvChange) => void): () => void {
    return onEnvironmentEnvChanged(listener);
  }

  async createDeploymentFromGitHub(
    ...args: Parameters<CreateFromGitHub>
  ): Promise<Awaited<ReturnType<CreateFromGitHub>>> {
    return (await this.deployments()).createDeploymentFromGitHub(...args);
  }

  async rebuildDeployment(...args: Parameters<Rebuild>): Promise<Awaited<ReturnType<Rebuild>>> {
    return (await this.deployments()).rebuildDeployment(...args);
  }

  async setDeploymentBranch(deploymentId: string, branch: string): Promise<void> {
    this.requireWrite();
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { githubBranch: branch }
    });
  }

  async createEnvironment(
    ...args: Parameters<CreateEnvironment>
  ): Promise<Awaited<ReturnType<CreateEnvironment>>> {
    return (await this.environments()).createEnvironment(...args);
  }

  async deleteEnvironment(
    ...args: Parameters<DeleteEnvironment>
  ): Promise<Awaited<ReturnType<DeleteEnvironment>>> {
    return (await this.environments()).deleteEnvironment(...args);
  }

  async deleteEnvironmentFromCluster(
    ...args: Parameters<DeleteFromCluster>
  ): Promise<Awaited<ReturnType<DeleteFromCluster>>> {
    return (await this.environments()).deleteEnvironmentFromCluster(...args);
  }

  async createAutoIngressForDeployment(
    ...args: Parameters<AutoIngress>
  ): Promise<Awaited<ReturnType<AutoIngress>>> {
    this.requireWrite();
    const { IngressService } = await import('../../projects/ingress.service.js');
    return this.moduleRef.get(IngressService, { strict: false }).createAutoIngressForDeployment(...args);
  }

  private requireWrite(): void {
    if (!this.graft.manifest!.capabilities.includes('projects.write')) {
      throw new Error(`graft ${this.graft.id} needs the "projects.write" capability to change projects`);
    }
  }

  private async deployments(): Promise<DeploymentsService> {
    this.requireWrite();
    const { DeploymentsService } = await import('../../projects/deployments.service.js');
    return this.moduleRef.get(DeploymentsService, { strict: false });
  }

  private async environments(): Promise<EnvironmentsService> {
    this.requireWrite();
    const { EnvironmentsService } = await import('../../projects/environments.service.js');
    return this.moduleRef.get(EnvironmentsService, { strict: false });
  }
}
