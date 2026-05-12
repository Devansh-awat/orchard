import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { SuperAdminGuard } from './superadmin.guard';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { PasswordlessController } from './passwordless.controller';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { RateLimitService } from './rate-limit.service';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokensController } from './api-tokens.controller';
import { SessionsService } from './sessions.service';
import { MembershipCacheService } from './membership-cache.service';
import { AuthorizationService } from './authorization.service';
import { StorageService } from '../organizations/storage.service';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [UsersModule, EmailModule, PrismaModule],
  controllers: [OAuthController, PasswordlessController, ApiTokensController],
  providers: [
    AuthGuard,
    SuperAdminGuard,
    OAuthService,
    OtpService,
    PasskeyService,
    RateLimitService,
    ApiTokensService,
    SessionsService,
    MembershipCacheService,
    AuthorizationService,
    StorageService,
    {
      provide: APP_GUARD,
      useClass: SuperAdminGuard,
    },
  ],
  exports: [AuthGuard, SuperAdminGuard, OAuthService, OtpService, PasskeyService, RateLimitService, ApiTokensService, SessionsService, MembershipCacheService, AuthorizationService],
})
export class AuthModule {}

