import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GitHubService } from '../github/github.service';
import type { FileReader } from '../github/framework-detect';
import { GitConnectionsService } from './git-connections.service';

export interface RepoSource {
  repoUrl: string;
  branch: string;
  gitConnectionId?: string | null;
  accessToken?: string | null;
  userId?: string | null;
  appAuthorized?: boolean;
}

/**
 * One way to read a file out of an app's repository whichever forge it
 * lives on: the GitHub App or user token for github.com, the person's
 * connection for everything else. Reads are cached per reader and never
 * throw; a missing file is null, like the detection reader.
 */
@Injectable()
export class RepoFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubService,
    private readonly connections: GitConnectionsService
  ) {}

  async readerFor(source: RepoSource): Promise<FileReader | null> {
    const cache = new Map<string, Promise<string | null>>();
    const wrap = (read: (path: string) => Promise<string | null>): FileReader => {
      return (path) => {
        if (!cache.has(path))
          cache.set(
            path,
            read(path).catch(() => null)
          );
        return cache.get(path)!;
      };
    };
    if (source.gitConnectionId) {
      const row = await this.prisma.gitConnection.findUnique({
        where: { id: source.gitConnectionId }
      });
      if (!row) return null;
      const repoPath = this.connections.repoPathFor(row.baseUrl, source.repoUrl);
      if (!repoPath) return null;
      const provider = await this.connections.providerForRow(row);
      return wrap((path) => provider.readFile(repoPath, path, source.branch));
    }
    const repo = this.github.parseRepoUrl(source.repoUrl);
    if (!repo) return null;
    let token: string | null = source.accessToken ?? null;
    if (!token && source.userId) {
      token = source.appAuthorized
        ? await this.github.resolveRepoToken(source.userId, repo.owner, repo.repo)
        : await this.github.getValidUserToken(source.userId);
    }
    if (!token) return null;
    return wrap((path) =>
      this.github.getFileContent(token!, repo.owner, repo.repo, path, source.branch)
    );
  }

  async readerForDeployment(
    deploymentId: string,
    extra: { accessToken?: string | null; userId?: string | null } = {}
  ): Promise<FileReader | null> {
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        githubRepo: true,
        githubBranch: true,
        autoDeployBranch: true,
        gitConnectionId: true,
        githubInstallationId: true,
        createdBy: true
      }
    });
    if (!dep?.githubRepo) return null;
    return this.readerFor({
      repoUrl: dep.githubRepo,
      branch: dep.autoDeployBranch || dep.githubBranch || 'main',
      gitConnectionId: dep.gitConnectionId,
      accessToken: extra.accessToken,
      userId: extra.userId ?? dep.createdBy,
      appAuthorized: dep.githubInstallationId !== null
    });
  }
}
