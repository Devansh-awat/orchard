import { Controller, Get, Post, Query, Param, Req, Body, Delete, HttpException, HttpStatus, Res, Headers, RawBodyRequest } from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { GitHubService, GitHubBranch, GitHubContent } from './github.service';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { GithubAppConfigService } from './github-app-config.service';
import { DeploymentsService } from '../projects/deployments.service';
import { Public, Auth } from '../auth/decorators';
import { setGithubOauthStateCookie, clearGithubOauthStateCookie } from '../auth/cookies';
import { changedFilesFromPush, partitionByWatchPaths } from './watch-paths';
import { autoDeployMatchesBranch, pushCommitSha } from './auto-deploy-match';

/** Only allow same-origin, non-protocol-relative return paths. */
function isSafeRedirect(redirect?: string): redirect is string {
  return !!redirect && redirect.startsWith('/') && !redirect.startsWith('//');
}

/** Recover the session token and optional return path from the OAuth state param. */
function parseLinkState(state?: string): { stateToken?: string; returnPath?: string; nonce?: string } {
  if (!state) return {};
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.t === 'string') {
      return {
        stateToken: parsed.t,
        returnPath: isSafeRedirect(parsed.r) ? parsed.r : undefined,
        nonce: typeof parsed.n === 'string' ? parsed.n : undefined,
      };
    }
  } catch {
    // Not encoded JSON — treat the whole state as a raw session token.
  }
  return { stateToken: state };
}

function csrfNonceMatches(nonce?: string, cookieNonce?: string): boolean {
  if (!nonce || !cookieNonce) return false;
  const a = Buffer.from(nonce, 'utf8');
  const b = Buffer.from(cookieNonce, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

@Auth()
@Controller('github')
export class GitHubController {
  constructor(
    private readonly githubService: GitHubService,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly deployments: DeploymentsService,
    private readonly githubAppConfig: GithubAppConfigService,
  ) {}

  /**
   * Resolve an access token for a repo. Tries the user's linked GitHub token first,
   * then falls back to checking if the repo is public (unauthenticated access).
   */
  private async resolveRepoAccess(user: any, owner: string, repo: string): Promise<string> {
    // If user has a GitHub token, try authenticated access first
    if (user.githubAccessToken) {
      const canAccess = await this.githubService.verifyUserCanAccessRepo(user.id, owner, repo);
      if (canAccess) {
        const token = await this.githubService.resolveRepoToken(user.id, owner, repo);
        if (token) return token;
      }
    }

    // Fallback: check if the repo is public
    const isPublic = await this.githubService.isRepoPublic(owner, repo);
    if (!isPublic) {
      throw new HttpException(
        'You do not have access to this repository on GitHub. Connect your GitHub account or check the repository URL.',
        HttpStatus.FORBIDDEN,
      );
    }

    // For public repos, user's OAuth token works (if available) — otherwise
    // the GitHub service methods will use unauthenticated requests.
    if (user.githubAccessToken) {
      const token = await this.githubService.getValidUserToken(user.id);
      if (token) return token;
    }

    // Public repo, no user token — return empty string; service methods need
    // to handle this by omitting the Authorization header.
    return '';
  }

  @Public()
  @Get('link')
  async initiateLink(@Req() req: any, @Res() res: Response, @Query('redirect') redirect?: string) {
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

    const clientId = this.githubService.getOAuthClientId();
    if (!clientId) {
      // Without an App there is no client id, and building the URL anyway sent
      // people to github.com with `client_id=null`, which is a GitHub error page
      // rather than anything Orchard can explain.
      const back = isSafeRedirect(redirect) ? redirect : '/user/settings';
      const message = encodeURIComponent(
        'This instance has no GitHub App yet, so there is nothing to connect to. A superadmin creates one in setup.',
      );
      return res.redirect(`${frontendUrl}${back}${back.includes('?') ? '&' : '?'}error=${message}`);
    }
    const redirectUri = this.githubAppConfig.callbackUrl();

    // Pass the session token as OAuth state so the callback can identify the
    // user even when the browser drops the cookie (e.g. SameSite restrictions).
    // When a same-origin return path is supplied, carry it alongside the token
    // so the callback knows where to send the user back (e.g. onboarding flow).
    const nonce = crypto.randomBytes(32).toString('hex');
    setGithubOauthStateCookie(res, nonce);
    const safeRedirect = isSafeRedirect(redirect) ? redirect : undefined;
    const state = Buffer.from(
      JSON.stringify({ t: token, r: safeRedirect, n: nonce }),
    ).toString('base64url');
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;

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
      // State carries the session JWT, and optionally a same-origin return path
      // encoded as base64url JSON. Older flows pass the raw JWT as state.
      const { stateToken, returnPath, nonce } = parseLinkState(state);

      const cookieNonce = req.cookies?.github_oauth_state;
      clearGithubOauthStateCookie(res);
      if (!csrfNonceMatches(nonce, cookieNonce)) {
        return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('This GitHub link request could not be verified. Please try connecting again.')}`);
      }

      // Prefer the cookie, fall back to the token from state when the browser
      // strips the cookie on cross-site redirect.
      const token = req.cookies?.session_token || stateToken;

      if (!token) {
        return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Not authenticated')}`);
      }

      const payload = await this.githubService.verifySessionToken(token);
      const user = payload.externalAuthId
        ? await this.usersService.findByExternalAuthId(payload.externalAuthId)
        : await this.usersService.findById(payload.sub);

      if (!user) {
        return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent('Not authenticated')}`);
      }

      await this.githubService.linkGitHubAccount(user.id, code);
      this.usersService.invalidateUserCache(user);

      const dest = returnPath || '/user/settings';
      const sep = dest.includes('?') ? '&' : '?';
      return res.redirect(`${frontendUrl}${dest}${sep}github=linked`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('GitHub OAuth callback error:', msg, err);
      return res.redirect(`${frontendUrl}/user/settings?error=${encodeURIComponent(msg)}`);
    }
  }

  @Post('link')
  async linkAccount(@Req() req: any, @Body('code') code: string) {
    const externalAuthId = req.user.externalAuthId || req.user.sub;

    if (!code) {
      throw new HttpException('Code is required', HttpStatus.BAD_REQUEST);
    }

    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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
    const externalAuthId = req.user.externalAuthId || req.user.sub;

    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    // Whether the instance can offer GitHub at all, which is a different
    // question from whether this user has linked it. Without it the UI has no
    // way to tell "not connected yet" from "there is nothing to connect to".
    const appConfigured = this.githubAppConfig.isConfigured();

    if (!user.githubId) {
      return { linked: false, username: null, tokenExpired: false, installations: [], appConfigured };
    }

    const token = await this.githubService.getValidUserToken(user.id);
    if (!token) {
      return {
        linked: true,
        username: user.githubUsername,
        tokenExpired: true,
        installations: [],
        appConfigured,
      };
    }

    const installations = await this.githubService.getUserInstallations(user.id);

    return {
      linked: true,
      username: user.githubUsername,
      tokenExpired: false,
      installations: installations.map(inst => ({
        id: inst.id,
        installationId: inst.installationId.toString(),
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        repositorySelection: inst.repositorySelection,
      })),
      appConfigured,
    };
  }

  @Get('repositories')
  async getRepositories(@Req() req: any, @Query('all') all?: string) {
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const token = await this.resolveRepoAccess(user, owner, repo);

    return this.githubService.getRepoBranches(token, owner, repo);
  }

  @Get('repositories/:owner/:repo/dockerfiles')
  async getDockerfiles(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const token = await this.resolveRepoAccess(user, owner, repo);

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
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const token = await this.resolveRepoAccess(user, owner, repo);

    return this.githubService.getRepoContents(token, owner, repo, path || '', branch);
  }

  @Get('repositories/:owner/:repo/detect')
  async detectRepoConfig(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('branch') branch?: string
  ) {
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
      email: req.user.email,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    }

    const token = await this.resolveRepoAccess(user, owner, repo);

    return this.githubService.detectRepoConfig(token, owner, repo, branch);
  }

  @Get('repositories/:owner/:repo/dockerfile-stages')
  async getDockerfileStages(
    @Req() req: any,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('dockerfilePath') dockerfilePath: string,
    @Query('branch') branch?: string
  ): Promise<string[]> {
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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

    const token = await this.resolveRepoAccess(user, owner, repo);

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
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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

    const token = await this.resolveRepoAccess(user, owner, repo);

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
      this.githubService.clearUserInstallationsCache();
      if (event === 'installation_repositories') {
        await this.githubService.applyInstallationReposEvent(
          BigInt(body.installation.id),
          body.repositories_added ?? [],
          body.repositories_removed ?? [],
        );
      } else if (body.action === 'created') {
        void this.githubService
          .syncInstallationReposById(BigInt(body.installation.id))
          .catch((e) => console.error('[GitHub App] mirror seed on install failed:', e?.message ?? e));
      }
      return { received: true, action: 'processed', event };
    }

    if (event === 'repository' && body.installation?.id) {
      // `changes.repository.name.from` is the only place the old name appears,
      // and it is what reattaches rows that were linked before we started
      // recording repository ids.
      const renamedFrom = body.changes?.repository?.name?.from
        ? `${body.repository?.owner?.login}/${body.changes.repository.name.from}`
        : null;
      await this.githubService.applyRepositoryEvent(
        BigInt(body.installation.id),
        body.action,
        body.repository,
        renamedFrom,
      );
      return { received: true, action: 'processed', event };
    }

    if (event === 'push') {
      // Handle push events - trigger auto-deploy for matching deployments
      const repoFullName = body.repository?.full_name;
      const pushedBranch = body.ref?.replace('refs/heads/', '');
      const commitSha = pushCommitSha(body);
      const commitMessage = body.head_commit?.message || 'No commit message';
      const commitAuthorName = body.head_commit?.author?.name as string | undefined;
      const commitAuthorUsername = body.head_commit?.author?.username as string | undefined;
      const senderInstallationId = body.installation?.id;

      if (!repoFullName || !pushedBranch) {
        return { received: true, action: 'ignored', reason: 'missing repo or branch info' };
      }

      // Deleting a branch is delivered as a push to that branch. There is no
      // commit to build, so this stops short of the match rather than starting
      // a doomed build against the null sha.
      if (!commitSha) {
        const reason = `no commit to deploy on ${repoFullName}:${pushedBranch}`;
        console.log(`[GitHub App] Push ignored: ${reason}`);
        return { received: true, action: 'ignored', reason };
      }

      if (!senderInstallationId) {
        // No installation context — refuse rather than match by repo name
        // alone (would let any installation impersonate a repo by full_name).
        return { received: true, action: 'ignored', reason: 'missing installation context' };
      }

      console.log(`[GitHub App] Push to ${repoFullName}:${pushedBranch} - ${commitSha?.substring(0, 7)}`);
      void this.githubService
        .touchRepoPush(BigInt(senderInstallationId), body.repository)
        .catch(() => {});

      // Matched on the repository id where we have it and the canonical https
      // URL otherwise, always scoped to the owning installation. Legacy rows
      // with githubInstallationId === null are intentionally excluded — they
      // must be re-linked via enableAutoDeploy before they will fire.
      const installationIdBig = BigInt(senderInstallationId);
      const candidates = await this.githubService.findAutoDeployTargets(
        installationIdBig,
        body.repository?.id ? BigInt(body.repository.id) : null,
        repoFullName,
      );

      const deployments = candidates.filter((deployment) =>
        autoDeployMatchesBranch(deployment, pushedBranch),
      );

      if (deployments.length === 0) {
        const reason = `no auto-deploy deployments for ${repoFullName}:${pushedBranch}`;
        console.log(`[GitHub App] Push ignored: ${reason}`);
        return { received: true, action: 'ignored', reason };
      }

      // A match in the push payload can be trusted: that file really did
      // change. A non-match cannot, because GitHub caps the commit array and
      // promises nothing about the per-commit file lists, so a deployment about
      // to be skipped gets a second opinion from the compare API first. Only
      // the about-to-skip path pays for the round trip; a repo where everything
      // matched, or where nothing filters by path, never calls out at all.
      const fromPayload = partitionByWatchPaths(deployments, changedFilesFromPush(body));
      let watched = fromPayload.watched;

      if (fromPayload.unmatched.length > 0) {
        const comparedFiles = await this.githubService.compareChangedFiles(
          installationIdBig,
          repoFullName,
          body.before,
          commitSha,
        );
        // An unknown answer matches everything, so a compare GitHub could not
        // give us builds the deployment rather than dropping its push.
        watched = watched.concat(partitionByWatchPaths(fromPayload.unmatched, comparedFiles).watched);
      }

      const skippedByPaths = deployments.length - watched.length;
      if (skippedByPaths > 0) {
        console.log(`[GitHub App] ${skippedByPaths} deployment(s) skipped, no watched paths changed`);
      }

      if (watched.length === 0) {
        return {
          received: true,
          action: 'ignored',
          reason: `no watched paths changed for ${repoFullName}:${pushedBranch}`,
          skipped: skippedByPaths,
        };
      }

      console.log(`[GitHub App] Triggering auto-deploy for ${watched.length} deployment(s)`);

      // Trigger rebuilds for all matching deployments
      const results = await Promise.allSettled(
        watched.map(async (deployment) => {
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

      results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        const name = watched[index]?.name ?? watched[index]?.id;
        const reason = (result.reason as Error)?.message ?? result.reason;
        console.error(
          `[GitHub App] Auto-deploy of ${name} for ${repoFullName}@${commitSha?.substring(0, 7)} was dropped: ${reason}`,
        );
      });

      return {
        received: true,
        action: 'deploying',
        commit: commitSha?.substring(0, 7),
        message: commitMessage.split('\n')[0],
        deployments: {
          total: deployments.length,
          triggered: successful,
          failed,
          skipped: skippedByPaths,
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
    const externalAuthId = req.user.externalAuthId || req.user.sub;
    const user = await this.usersService.findOrCreateByClerkId(externalAuthId, {
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

