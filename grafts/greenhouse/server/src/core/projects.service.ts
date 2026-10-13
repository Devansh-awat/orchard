import { Inject, Injectable, Logger } from '@nestjs/common';
import { Doors, type ProjectsDoor } from '@orchard/graft-sdk/server';

type UserData = Record<string, unknown> | undefined;

type AutoIngress = {
  createAutoIngressForDeployment?(
    deploymentId: string,
    clerkId: string,
    userData?: Record<string, unknown>
  ): Promise<unknown>;
};

export interface EnvironmentEnvChange {
  projectId?: string | null;
  environmentId?: string | null;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger('GreenhouseProjects');

  constructor(@Inject(Doors.projects) private readonly projects: ProjectsDoor) {}

  readonly deployments = {
    createDeploymentFromGitHub: (
      projectId: string,
      data: Record<string, unknown>,
      clerkId: string,
      userData?: UserData
    ) => this.projects.createDeploymentFromGitHub(projectId, data, clerkId, userData),
    rebuildDeployment: (deploymentId: string, clerkId: string, userData?: UserData) =>
      this.projects.rebuildDeployment(deploymentId, clerkId, userData)
  };

  readonly environments = {
    createEnvironment: (
      projectId: string,
      input: { name: string; slug?: string },
      userId: string
    ) => this.projects.createEnvironment(projectId, input, userId),
    deleteEnvironment: (
      environmentId: string,
      actor: { userId: string; email?: string },
      confirmName: unknown
    ) => this.projects.deleteEnvironment(environmentId, actor, confirmName),
    deleteEnvironmentFromCluster: (
      environmentId: string,
      cause: { reason: string; source: string; namespace: string }
    ) => this.projects.deleteEnvironmentFromCluster(environmentId, cause)
  };

  readonly ingress = {
    createAutoIngressForDeployment: async (
      deploymentId: string,
      clerkId: string,
      userData?: UserData
    ): Promise<unknown> => {
      const door = this.projects as ProjectsDoor & AutoIngress;
      if (typeof door.createAutoIngressForDeployment !== 'function') {
        this.logger.warn(
          `this Orchard cannot generate a preview URL for ${deploymentId}: the projects door has no createAutoIngressForDeployment`
        );
        return null;
      }
      return door.createAutoIngressForDeployment(deploymentId, clerkId, userData);
    }
  };

  setDeploymentBranch(deploymentId: string, branch: string): Promise<void> {
    return this.projects.setDeploymentBranch(deploymentId, branch);
  }

  onEnvironmentEnvChanged(listener: (change: EnvironmentEnvChange) => void): () => void {
    return this.projects.onEnvironmentEnvChanged(listener);
  }
}
