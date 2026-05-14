import { Module } from '@nestjs/common';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpTransportController } from './mcp-transport.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { McpTransportService } from './mcp-transport.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionsService } from '../auth/sessions.service';

@Module({
  imports: [PrismaModule],
  controllers: [McpOAuthController, McpTransportController],
  providers: [McpOAuthService, McpTransportService, SessionsService],
})
export class McpModule {}
