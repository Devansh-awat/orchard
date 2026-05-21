import { Controller, Get, Post, Query, Param, Req, Body, Delete, HttpException, HttpStatus, Res, Headers, RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import { GitHubService, GitHubRepo, GitHubBranch, GitHubContent, GitHubWebhookPayload } from './github.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { DeploymentsService } from '../projects/deployments.service';
import { Public, Auth } from '../auth/decorators';

@Auth()
@Controller('github')
export class GitHubController {
  constructor(
    private readonly githubService: GitHubService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly deployments: DeploymentsService,
  ) {}

  @Public()
  @Get('link')
  async initiateLink(@Req() req: any, @Res() res: Response) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const token = req.cookies?.session_token;

    if (!token) {
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Not authenticated')}`);
    }

    try {
      await this.githubService.verifySessionToken(token);
    } catch {
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Not authenticated')}`);
    }

    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = process.env.GITHUB_REDIRECT_URI;

    // GitHub Apps ignore the `scope` param — user-to-server tokens inherit App permissions.
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    return res.redirect(authUrl);
  }

  @Public()
  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('error') error: string,
    @Query('state') state: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    if (error) {
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('No authorization code provided')}`);
    }

    try {
      const token = req.cookies?.session_token;
      
      if (!token) {
        return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Not authenticated')}`);
      }

      const payload = await this.githubService.verifySessionToken(token);
      const hackClubId = payload.hackClubId || payload.sub;
      
      if (!hackClubId) {
        return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Invalid session token')}`);
      }

      const user = await this.usersService.findOrCreateByHackClubId({
        id: hackClubId,
        email: payload.email,
        name: payload.name,
      });

      await this.githubService.linkGitHubAccount(user.id, code);
      this.usersService.invalidateUserCache(user);

      return res.redirect(`${frontendUrl}/user/settings?github=linked`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('GitHub OAuth callback error:', msg, err);
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent(msg)}`);
    }
  }

  @Post('link')
  async linkAccount(@Req() req: any, @Body('code') code: string) {
    const hackClubId = req.user.hackClubId || req.user.sub;

    if (!code) {
      throw new HttpException('Code is required', HttpStatus.BAD_REQUEST);
    }

    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    await this.githubService.linkGitHubAccount(user.id, code);
    this.usersService.invalidateUserCache(user);

    return { success: true, message: 'GitHub account linked successfully' };
  }

  @Delete('unlink')
  async unlinkAccount(@Req() req: any) {
    const hackClubId = req.user.hackClubId || req.user.sub;

    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    await this.githubService.unlinkGitHubAccount(user.id);
    this.usersService.invalidateUserCache(user);

    return { success: true, message: 'GitHub account unlinked successfully' };
  }

  @Get('status')
  async getStatus(@Req() req: any) {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const installations = await this.githubService.getUserInstallations(user.id);

    return {
      linked: !!user.githubId,
      username: user.githubUsername,
      installations: installations.map(inst => ({
        id: inst.id,
        installationId: inst.installationId.toString(),
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        repositorySelection: inst.repositorySelection,
      })),
    };
  }

  @Get('repositories')
  async getRepositories(@Req() req: any, @Query('all') all?: string) {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    // We require a linked GitHub account so we can verify per-repo access.
    if (!user.githubAccessToken) {
      throw new HttpException(
        'Connect your GitHub account to view deployable repositories. We use it to verify which repos you have access to.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Prefer App installation repos (intersected with user-accessible), fall back to OAuth listing.
    const { repos, installations, hasInstallations } = await this.githubService.getAllUserRepositories(user.id);

    if (hasInstallations) {
      return { repositories: repos, installations, source: 'app' };
    }

    const maxPages = all === 'true' ? 10 : 3;
    const userToken = await this.githubService.getValidUserToken(user.id);
    if (!userToken) {
      throw new HttpException(
        'Your GitHub session expired. Please reconnect your GitHub account.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const oauthRepos = await this.githubService.getUserRepositories(userToken, maxPages);
    return { repositories: oauthRepos, installations: [], source: 'oauth' };
  }

  @Get('repositories/:owner/:repo/branches')
  async getBranches(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string
  ): Promise<GitHubBranch[]> {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('Connect your GitHub account to deploy from repositories. We use it to verify your access.', HttpStatus.BAD_REQUEST);
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
    if (!canAccess) {
      throw new HttpException('You do not have access to this repository on GitHub.', HttpStatus.FORBIDDEN);
    }
    const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
    if (!token) {
      throw new HttpException('No access to this repository. Install the GitHub App or link your GitHub account.', HttpStatus.BAD_REQUEST);
    }

    return this.githubService.getRepoBranches(token, owner, repo);
  }

  @Get('repositories/:owner/:repo/dockerfiles')
  async getDockerfiles(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('Connect your GitHub account to deploy from repositories. We use it to verify your access.', HttpStatus.BAD_REQUEST);
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
    if (!canAccess) {
      throw new HttpException('You do not have access to this repository on GitHub.', HttpStatus.FORBIDDEN);
    }
    const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
    if (!token) {
      throw new HttpException('No access to this repository. Install the GitHub App or link your GitHub account.', HttpStatus.BAD_REQUEST);
    }

    return this.githubService.findDockerfiles(token, owner, repo, branch);
  }

  @Get('repositories/:owner/:repo/contents')
  async getContents(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('path') path?: string,
    @Query('branch') branch?: string
  ): Promise<GitHubContent[]> {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('Connect your GitHub account to deploy from repositories. We use it to verify your access.', HttpStatus.BAD_REQUEST);
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
    if (!canAccess) {
      throw new HttpException('You do not have access to this repository on GitHub.', HttpStatus.FORBIDDEN);
    }
    const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
    if (!token) {
      throw new HttpException('No access to this repository. Install the GitHub App or link your GitHub account.', HttpStatus.BAD_REQUEST);
    }

    return this.githubService.getRepoContents(token, owner, repo, path || '', branch);
  }

  @Get('repositories/:owner/:repo/dockerfile-stages')
  async getDockerfileStages(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('dockerfilePath') dockerfilePath: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    if (!dockerfilePath) {
      throw new HttpException('Dockerfile path is required', HttpStatus.BAD_REQUEST);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('Connect your GitHub account to deploy from repositories. We use it to verify your access.', HttpStatus.BAD_REQUEST);
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
    if (!canAccess) {
      throw new HttpException('You do not have access to this repository on GitHub.', HttpStatus.FORBIDDEN);
    }
    const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
    if (!token) {
      throw new HttpException('No access to this repository. Install the GitHub App or link your GitHub account.', HttpStatus.BAD_REQUEST);
    }

    return this.githubService.getDockerfileStages(token, owner, repo, dockerfilePath, branch);
  }

  @Get('repositories/:owner/:repo/dockerfile-info')
  async getDockerfileInfo(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('dockerfilePath') dockerfilePath: string,
    @Query('branch') branch?: string
  ): Promise<{ exposedPorts: number[]; envVars: { key: string; value: string }[]; stages: string[] }> {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    if (!dockerfilePath) {
      throw new HttpException('Dockerfile path is required', HttpStatus.BAD_REQUEST);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('Connect your GitHub account to deploy from repositories. We use it to verify your access.', HttpStatus.BAD_REQUEST);
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
    if (!canAccess) {
      throw new HttpException('You do not have access to this repository on GitHub.', HttpStatus.FORBIDDEN);
    }
    const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
    if (!token) {
      throw new HttpException('No access to this repository. Install the GitHub App or link your GitHub account.', HttpStatus.BAD_REQUEST);
    }

    return this.githubService.getDockerfileInfo(token, owner, repo, dockerfilePath, branch);
  }

  @Public()
  @Post('app/webhook')
  async handleAppWebhook(
    @Headers('x-github-event') event: string,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-delivery') deliveryId: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any
  ) {
    console.log(`[GitHub App] Received ${event} event, delivery: ${deliveryId}`);

    // Verify the webhook signature
    const rawBody = req.rawBody?.toString() || JSON.stringify(body);

    try {
      const isValid = this.githubService.verifyAppWebhookSignature(rawBody, signature);
      if (!isValid) {
        console.error('[GitHub App] Invalid webhook signature');
        throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
      }
    } catch (e) {
      if (e instanceof HttpException) throw e;
      console.error('[GitHub App] Signature verification error:', e);
      throw new HttpException('Webhook verification failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Handle different event types
    if (event === 'installation' || event === 'installation_repositories') {
      // Handle app installation events
      await this.githubService.handleInstallationEvent(
        body.action,
        body.installation,
        body.sender
      );
      return { received: true, action: 'processed', event };
    }

    if (event === 'push') {
      // Handle push events - trigger auto-deploy for matching deployments
      const repoFullName = body.repository?.full_name;
      const pushedBranch = body.ref?.replace('refs/heads/', '');
      const commitSha = body.after || body.head_commit?.id;
      const commitMessage = body.head_commit?.message || 'No commit message';
      const commitAuthorName = body.head_commit?.author?.name as string | undefined;
      const commitAuthorUsername = body.head_commit?.author?.username as string | undefined;
      const senderInstallationId = body.installation?.id;

      if (!repoFullName || !pushedBranch) {
        return { received: true, action: 'ignored', reason: 'missing repo or branch info' };
      }

      if (!senderInstallationId) {
        // No installation context — refuse rather than match by repo name
        // alone (would let any installation impersonate a repo by full_name).
        return { received: true, action: 'ignored', reason: 'missing installation context' };
      }

      console.log(`[GitHub App] Push to ${repoFullName}:${pushedBranch} - ${commitSha?.substring(0, 7)}`);

      const repoUrl = `https://github.com/${repoFullName}`;
      const installationIdBig = BigInt(senderInstallationId);
      // Match by canonical https URL AND owning installation. Legacy rows
      // with githubInstallationId === null are intentionally excluded — they
      // must be re-linked via enableAutoDeploy before they will fire.
      const deployments = await this.prisma.deployment.findMany({
        where: {
          githubRepo: repoUrl,
          githubInstallationId: installationIdBig,
          autoDeployEnabled: true,
          autoDeployBranch: pushedBranch,
        },
        include: {
          project: {
            include: {
              organization: true,
            },
          },
        },
      });

      if (deployments.length === 0) {
        // Also check for deployments where autoDeployBranch is null but githubBranch matches
        const fallbackDeployments = await this.prisma.deployment.findMany({
          where: {
            githubRepo: repoUrl,
            githubInstallationId: installationIdBig,
            autoDeployEnabled: true,
            autoDeployBranch: null,
            githubBranch: pushedBranch,
          },
          include: {
            project: {
              include: {
                organization: true,
              },
            },
          },
        });
        deployments.push(...fallbackDeployments);
      }

      if (deployments.length === 0) {
        return {
          received: true,
          action: 'ignored',
          reason: `no auto-deploy deployments for ${repoFullName}:${pushedBranch}`
        };
      }

      console.log(`[GitHub App] Triggering auto-deploy for ${deployments.length} deployment(s)`);

      // Trigger rebuilds for all matching deployments
      const results = await Promise.allSettled(
        deployments.map(async (deployment) => {
          console.log(`[GitHub App] Auto-deploying ${deployment.name} from commit ${commitSha?.substring(0, 7)}`);
          await this.deployments.triggerAutoDeploy(
            deployment.id,
            commitSha,
            commitMessage,
            commitAuthorName,
            commitAuthorUsername,
          );
          return deployment.name;
        })
      );

      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      return {
        received: true,
        action: 'deploying',
        commit: commitSha?.substring(0, 7),
        message: commitMessage.split('\n')[0],
        deployments: {
          total: deployments.length,
          triggered: successful,
          failed,
        },
      };
    }

    // Ignore other events
    return { received: true, action: 'ignored', reason: `unhandled event type: ${event}` };
  }

  @Get('app/install')
  async getAppInstallUrl() {
    try {
      const url = this.githubService.getAppInstallationUrl();
      return { url };
    } catch (e) {
      throw new HttpException('GitHub App not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  @Get('app/installations')
  async getUserInstallations(@Req() req: any) {
    const hackClubId = req.user.hackClubId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(hackClubId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const installations = await this.githubService.getUserInstallations(user.id);

    // Convert BigInt to string for JSON serialization
    return installations.map(inst => ({
      ...inst,
      installationId: inst.installationId.toString(),
      accountId: inst.accountId.toString(),
    }));
  }

}

