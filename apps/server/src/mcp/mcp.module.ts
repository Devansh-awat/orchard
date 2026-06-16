import { Module } from '@nestjs/common';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpTransportController } from './mcp-transport.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { McpTransportService } from './mcp-transport.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';

// We deliberately register AuditService as a provider here instead of importing
// AuditModule. AuditModule imports AuthModule (for its controller), which pulls
// in OAuthService and requires Hack Club OAuth env vars that the MCP server
// process doesn't have. The MCP only needs the service, not the controller.
@Module({
  imports: [PrismaModule, AnalyticsModule],
  controllers: [McpOAuthController, McpTransportController],
  providers: [McpOAuthService, McpTransportService, SessionsService, AuditService],
})
export class McpModule {}
