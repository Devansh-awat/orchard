import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import { SandboxesModule } from '../sandboxes.module';
import { SandboxEnabledGuard } from '../sandbox-enabled.guard';
import { GithubIssuesClient, LinearClient, SlackClient } from './integration-clients';
import { GreenhouseKickoffService, KickoffRateLimiter } from './greenhouse-kickoff.service';
import { GreenhouseIssuesService } from './greenhouse-issues.service';
import { GithubKickoffService } from './github-kickoff.service';
import { LinearKickoffService } from './linear-kickoff.service';
import { SlackKickoffService } from './slack-kickoff.service';
import { SlackLinkService } from './slack-link.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationWebhooksController } from './integration-webhooks.controller';

@Module({
  imports: [CoreModule, SandboxesModule],
  controllers: [IntegrationsController, IntegrationWebhooksController],
  providers: [
    { provide: LinearClient, useFactory: () => new LinearClient() },
    { provide: SlackClient, useFactory: () => new SlackClient() },
    { provide: GithubIssuesClient, useFactory: () => new GithubIssuesClient() },
    SandboxEnabledGuard,
    KickoffRateLimiter,
    GreenhouseKickoffService,
    GreenhouseIssuesService,
    GithubKickoffService,
    LinearKickoffService,
    SlackKickoffService,
    SlackLinkService
  ]
})
export class SandboxIntegrationsModule {}
