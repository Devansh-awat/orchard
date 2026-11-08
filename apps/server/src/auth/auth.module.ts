import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SuperAdminGuard, ScopeGuard } from './superadmin.guard';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { PasswordlessController } from './passwordless.controller';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { RateLimitService } from './rate-limit.service';
import { AuthCleanupService } from './auth-cleanup.service';
import { McpClientCleanupService } from './mcp-client-cleanup.service';
import { RedisThrottleService } from './redis-throttle.service';
import { TurnstileService } from './turnstile.service';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokensController } from './api-tokens.controller';
import { ProtectionService } from './protection.service';
import { ProtectionController } from './protection.controller';
import { SessionsService } from './sessions.service';
import { MembershipCacheService } from './membership-cache.service';
import { AuthorizationService } from './authorization.service';
import { StorageService } from '../organizations/storage.service';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [UsersModule, EmailModule, PrismaModule],
  controllers: [OAuthController, PasswordlessController, ApiTokensController, ProtectionController],
  providers: [
    SuperAdminGuard,
    OAuthService,
    OtpService,
    PasskeyService,
    RateLimitService,
    AuthCleanupService,
    McpClientCleanupService,
    RedisThrottleService,
    TurnstileService,
    ApiTokensService,
    ProtectionService,
    SessionsService,
    MembershipCacheService,
    AuthorizationService,
    StorageService,
    {
      provide: APP_GUARD,
      useClass: SuperAdminGuard
    },
    // ScopeGuard MUST follow SuperAdminGuard: it reads `request['auth']`
    // which SuperAdminGuard populates. Nest runs APP_GUARDs in registration
    // order, so this ordering is load-bearing.
    {
      provide: APP_GUARD,
      useClass: ScopeGuard
    }
  ],
  exports: [
    SuperAdminGuard,
    OAuthService,
    OtpService,
    PasskeyService,
    RateLimitService,
    RedisThrottleService,
    TurnstileService,
    ApiTokensService,
    ProtectionService,
    SessionsService,
    MembershipCacheService,
    AuthorizationService
  ]
})
export class AuthModule {}
