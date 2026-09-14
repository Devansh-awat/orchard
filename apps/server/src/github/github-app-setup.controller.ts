import { Controller, Get, Post, Body, Query, Res, Delete } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/decorators';
import { GithubAppSetupService } from './github-app-setup.service';
import { GithubAppConfigService } from './github-app-config.service';

@Controller('setup/github-app')
export class GithubAppSetupController {
  constructor(
    private readonly setup: GithubAppSetupService,
    private readonly config: GithubAppConfigService,
  ) {}

  @Get('status')
  status() {
    const c = this.config.get();
    return {
      configured: this.config.isConfigured(),
      slug: c.slug,
      appId: c.appId,
      lockedFields: this.config.lockedFields(),
      installUrl: this.setup.installUrl(),
      callbackUrl: this.config.callbackUrl(),
    };
  }

  @Post('manifest')
  manifest(@Body() body: { organization?: string; returnTo?: string }) {
    return this.setup.startManifestFlow(
      body?.organization?.trim() || undefined,
      body?.returnTo?.trim() || undefined,
    );
  }

  @Delete()
  async disconnect() {
    await this.config.clear();
    return { ok: true };
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    let returnTo: string | undefined;
    try {
      returnTo = await this.setup.completeManifestFlow(code, state);
    } catch (e: any) {
      const message = encodeURIComponent(e?.message || 'Could not create the GitHub App');
      return res.redirect(`${base}/setup/github?error=${message}`);
    }
    const target = returnTo ?? '/setup/github';
    const join = target.includes('?') ? '&' : '?';
    return res.redirect(`${base}${target}${join}created=1`);
  }
}
