import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import { GitHubService } from '../../github/github.service';
import { bindGraft, type DoorMeta } from './door';

type IssueCommentHandler = (
  deliveryId: string | undefined,
  body: unknown
) => Promise<Record<string, unknown>>;

@Injectable({ scope: Scope.TRANSIENT })
export class GitHubDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'github',
    version: 1,
    status: 'stable',
    capability: 'github'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef
  ) {
    bindGraft(parent, GitHubDoorV1.meta);
  }

  private get github(): GitHubService {
    return this.moduleRef.get(GitHubService, { strict: false });
  }

  userToken(userId: string): Promise<string | null> {
    return this.github.getValidUserToken(userId);
  }

  repoToken(userId: string, owner: string, repo: string): Promise<string | null> {
    return this.github.resolveRepoToken(userId, owner, repo);
  }

  installationToken(installationId: bigint): Promise<string> {
    return this.github.getOrRefreshInstallationToken(installationId);
  }

  onIssueComment(handler: IssueCommentHandler | null): void {
    this.github.setIssueCommentHandler(handler);
  }
}
