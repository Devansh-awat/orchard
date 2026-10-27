import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApiThrottlerGuard, apiThrottlerLimit } from '../auth/api-throttler.guard';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpTransportController } from './mcp-transport.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { McpTransportService } from './mcp-transport.service';
import { McpEnabledGuard } from './mcp-enabled.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';

// AuditService and InstanceSettingsService are registered as providers here
// rather than by importing their modules. AuditModule imports AuthModule (for
// its controller), which pulls in OAuthService and requires Hack Club OAuth env
// vars that the MCP server process doesn't have. InstanceSettingsModule is
// worse: importing it would mount admin/instance-settings on the MCP host,
// where SuperAdminGuard does not run and anyone could flip an instance toggle.
// The MCP only needs the services, never the controllers.
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60000, limit: apiThrottlerLimit }]),
    PrismaModule,
    AnalyticsModule
  ],
  controllers: [McpOAuthController, McpTransportController],
  providers: [
    { provide: APP_GUARD, useClass: McpEnabledGuard },
    { provide: APP_GUARD, useClass: ApiThrottlerGuard },
    McpOAuthService,
    McpTransportService,
    SessionsService,
    AuditService,
    InstanceSettingsService,
    SecretCryptoService
  ]
})
export class McpModule {}
