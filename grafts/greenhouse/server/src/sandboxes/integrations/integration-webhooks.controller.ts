import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '@orchard/graft-sdk/server';
import { LinearKickoffService } from './linear-kickoff.service';
import { SlackKickoffService } from './slack-kickoff.service';

function rawBodyOf(req: RawBodyRequest<Request>): string {
  return req.rawBody ? req.rawBody.toString('utf8') : '';
}

@Controller('integrations')
export class IntegrationWebhooksController {
  constructor(
    private readonly linear: LinearKickoffService,
    private readonly slack: SlackKickoffService
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @HttpCode(200)
  @Post('linear/webhook')
  linearWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('linear-signature') signature: string | undefined,
    @Headers('linear-delivery') delivery: string | undefined,
    @Body() body: unknown
  ) {
    return this.linear.handle({ rawBody: rawBodyOf(req), signature, delivery, body });
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @HttpCode(200)
  @Post('slack/commands')
  slackCommand(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-slack-request-timestamp') timestamp: string | undefined,
    @Headers('x-slack-signature') signature: string | undefined,
    @Body() body: unknown
  ) {
    return this.slack.handleCommand({ rawBody: rawBodyOf(req), timestamp, signature, body });
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  @HttpCode(200)
  @Post('slack/events')
  slackEvent(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-slack-request-timestamp') timestamp: string | undefined,
    @Headers('x-slack-signature') signature: string | undefined,
    @Body() body: unknown
  ) {
    return this.slack.handleEvent({ rawBody: rawBodyOf(req), timestamp, signature, body });
  }
}
