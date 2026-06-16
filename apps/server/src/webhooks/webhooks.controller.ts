import { Controller, Post, Param, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators';

@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // Extract a webhook token from either the Authorization: Bearer header
  // or the URL path. Header takes precedence — secrets in the path get
  // logged by every proxy / access log on the way in, so we want callers
  // migrating off the path-param form.
  private resolveToken(authHeader: string | undefined, pathToken?: string): string {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const headerToken = authHeader.substring(7).trim();
      if (headerToken) return headerToken;
    }
    if (pathToken && pathToken.length > 0) return pathToken;
    throw new UnauthorizedException('No webhook token provided');
  }

  @Post('deploy')
  async triggerDeployHeader(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { image?: string; tag?: string },
  ) {
    const token = this.resolveToken(authHeader);
    return this.webhooksService.triggerWebhookDeploy(
      token,
      body?.image,
      body?.tag,
    );
  }

  @Post('deploy/:token')
  async triggerDeploy(
    @Param('token') token: string,
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: { image?: string; tag?: string },
  ) {
    const resolved = this.resolveToken(authHeader, token);
    return this.webhooksService.triggerWebhookDeploy(
      resolved,
      body?.image,
      body?.tag,
    );
  }
}
