import { Controller, Get, Post, Query, Param, UseGuards, Req, Body, Delete, HttpException, HttpStatus, Res, Headers, RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import { GitHubService, GitHubRepo, GitHubBranch, GitHubContent, GitHubWebhookPayload } from './github.service';
import { AuthGuard } from '../auth/auth.guard';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

@Controller('github')
export class GitHubController {
  constructor(
    private readonly githubService: GitHubService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
  ) {}

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
    const scope = 'read:user user:email repo';

    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;

    return res.redirect(authUrl);
  }

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

      return res.redirect(`${frontendUrl}/user/settings?github=linked`);
    } catch (err) {
      console.error('GitHub OAuth callback error:', err);
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Failed to link GitHub account')}`);
    }
  }

  @Post('link')
  @UseGuards(AuthGuard)
  async linkAccount(@Req() req: any, @Body('code') code: string) {
    const hackClubId = req.user.sub;
    
    if (!code) {
      throw new HttpException('Code is required', HttpStatus.BAD_REQUEST);
    }

    const user = await this.usersService.findByHackClubId(hackClubId);
    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    await this.githubService.linkGitHubAccount(user.id, code);

    return { success: true, message: 'GitHub account linked successfully' };
  }

  @Delete('unlink')
  @UseGuards(AuthGuard)
  async unlinkAccount(@Req() req: any) {
    const hackClubId = req.user.sub;
    
    const user = await this.usersService.findByHackClubId(hackClubId);
    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    await this.githubService.unlinkGitHubAccount(user.id);

    return { success: true, message: 'GitHub account unlinked successfully' };
  }

  @Get('status')
  @UseGuards(AuthGuard)
  async getStatus(@Req() req: any) {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    return {
      linked: !!user.githubId,
      username: user.githubUsername,
    };
  }

  @Get('repositories')
  @UseGuards(AuthGuard)
  async getRepositories(@Req() req: any, @Query('all') all?: string): Promise<GitHubRepo[]> {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('GitHub account not linked', HttpStatus.BAD_REQUEST);
    }

    const maxPages = all === 'true' ? 10 : 3;
    const repos = await this.githubService.getUserRepositories(user.githubAccessToken, maxPages);

    return repos;
  }

  @Get('repositories/:owner/:repo/branches')
  @UseGuards(AuthGuard)
  async getBranches(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string
  ): Promise<GitHubBranch[]> {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('GitHub account not linked', HttpStatus.BAD_REQUEST);
    }

    const branches = await this.githubService.getRepoBranches(user.githubAccessToken, owner, repo);

    return branches;
  }

  @Get('repositories/:owner/:repo/dockerfiles')
  @UseGuards(AuthGuard)
  async getDockerfiles(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('GitHub account not linked', HttpStatus.BAD_REQUEST);
    }

    const dockerfiles = await this.githubService.findDockerfiles(
      user.githubAccessToken,
      owner,
      repo,
      branch
    );

    return dockerfiles;
  }

  @Get('repositories/:owner/:repo/contents')
  @UseGuards(AuthGuard)
  async getContents(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('path') path?: string,
    @Query('branch') branch?: string
  ): Promise<GitHubContent[]> {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('GitHub account not linked', HttpStatus.BAD_REQUEST);
    }

    const contents = await this.githubService.getRepoContents(
      user.githubAccessToken,
      owner,
      repo,
      path || '',
      branch
    );

    return contents;
  }

  @Get('repositories/:owner/:repo/dockerfile-stages')
  @UseGuards(AuthGuard)
  async getDockerfileStages(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('dockerfilePath') dockerfilePath: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    if (!user.githubAccessToken) {
      throw new HttpException('GitHub account not linked', HttpStatus.BAD_REQUEST);
    }

    if (!dockerfilePath) {
      throw new HttpException('Dockerfile path is required', HttpStatus.BAD_REQUEST);
    }

    const stages = await this.githubService.getDockerfileStages(
      user.githubAccessToken,
      owner,
      repo,
      dockerfilePath,
      branch
    );

    return stages;
  }

  // GitHub App webhook endpoint - receives all events from GitHub App
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

      if (!repoFullName || !pushedBranch) {
        return { received: true, action: 'ignored', reason: 'missing repo or branch info' };
      }

      console.log(`[GitHub App] Push to ${repoFullName}:${pushedBranch} - ${commitSha?.substring(0, 7)}`);

      // Find all deployments that match this repo and have auto-deploy enabled
      const repoUrl = `https://github.com/${repoFullName}`;
      const deployments = await this.prisma.deployment.findMany({
        where: {
          githubRepo: {
            contains: repoFullName,
          },
          autoDeployEnabled: true,
          autoDeployBranch: pushedBranch,
        },
        include: {
          project: {
            include: {
              workspace: true,
            },
          },
        },
      });

      if (deployments.length === 0) {
        // Also check for deployments where autoDeployBranch is null but githubBranch matches
        const fallbackDeployments = await this.prisma.deployment.findMany({
          where: {
            githubRepo: {
              contains: repoFullName,
            },
            autoDeployEnabled: true,
            autoDeployBranch: null,
            githubBranch: pushedBranch,
          },
          include: {
            project: {
              include: {
                workspace: true,
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
          await this.projectsService.triggerAutoDeploy(deployment.id, commitSha, commitMessage);
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

  // Get GitHub App installation URL
  @Get('app/install')
  @UseGuards(AuthGuard)
  async getAppInstallUrl() {
    try {
      const url = this.githubService.getAppInstallationUrl();
      return { url };
    } catch (e) {
      throw new HttpException('GitHub App not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  // Get user's GitHub App installations
  @Get('app/installations')
  @UseGuards(AuthGuard)
  async getUserInstallations(@Req() req: any) {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    const installations = await this.githubService.getUserInstallations(user.id);

    // Convert BigInt to string for JSON serialization
    return installations.map(inst => ({
      ...inst,
      installationId: inst.installationId.toString(),
      accountId: inst.accountId.toString(),
    }));
  }

  // Get repositories accessible through GitHub App installations
  @Get('app/repositories')
  @UseGuards(AuthGuard)
  async getAppRepositories(@Req() req: any) {
    const hackClubId = req.user.sub;
    const user = await this.usersService.findByHackClubId(hackClubId);

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    const installations = await this.githubService.getUserInstallations(user.id);

    if (installations.length === 0) {
      return { installations: [], repositories: [] };
    }

    // Get repositories from all installations
    const allRepos: any[] = [];
    const installationData: any[] = [];

    for (const installation of installations) {
      try {
        const repos = await this.githubService.getInstallationRepositories(installation.installationId);

        installationData.push({
          id: installation.id,
          installationId: installation.installationId.toString(),
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositoryCount: repos.length,
        });

        for (const repo of repos) {
          allRepos.push({
            ...repo,
            installationId: installation.installationId.toString(),
            accountLogin: installation.accountLogin,
          });
        }
      } catch (e) {
        console.error(`[GitHub App] Failed to get repos for installation ${installation.installationId}:`, e);
      }
    }

    return {
      installations: installationData,
      repositories: allRepos
    };
  }
}

