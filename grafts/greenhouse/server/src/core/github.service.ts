import { Inject, Injectable } from '@nestjs/common';
import { Doors, type GitHubDoor } from '@orchardlabs/graft-sdk/server';

type IssueCommentHandler = Parameters<GitHubDoor['onIssueComment']>[0];

@Injectable()
export class GitHubService {
  constructor(@Inject(Doors.github) private readonly github: GitHubDoor) {}

  getValidUserToken(userId: string): Promise<string | null> {
    return this.github.userToken(userId);
  }

  resolveRepoToken(userId: string, owner: string, repo: string): Promise<string | null> {
    return this.github.repoToken(userId, owner, repo);
  }

  getOrRefreshInstallationToken(installationId: bigint): Promise<string> {
    return this.github.installationToken(installationId);
  }

  async verifyUserCanAccessRepo(userId: string, owner: string, repo: string): Promise<boolean> {
    const token = await this.getValidUserToken(userId);
    if (!token) return false;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );
    return response.ok;
  }

  setIssueCommentHandler(handler: IssueCommentHandler): void {
    this.github.onIssueComment(handler);
  }
}
