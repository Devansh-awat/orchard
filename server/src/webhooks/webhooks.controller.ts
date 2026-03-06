import { Controller, Post, Param, Body } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators';

@Public()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('deploy/:token')
  async triggerDeploy(
    @Param('token') token: string,
    @Body() body: { image?: string; tag?: string },
  ) {
    return this.webhooksService.triggerWebhookDeploy(
      token,
      body?.image,
      body?.tag,
    );
  }
}
