import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { SuperAdminGuard } from './superadmin.guard';
import { OAuthService } from './oauth.service';
import { OAuthController } from './oauth.controller';
import { PasswordlessController } from './passwordless.controller';
import { OtpService } from './otp.service';
import { PasskeyService } from './passkey.service';
import { RateLimitService } from './rate-limit.service';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [UsersModule, EmailModule, PrismaModule],
  controllers: [OAuthController, PasswordlessController],
  providers: [AuthGuard, SuperAdminGuard, OAuthService, OtpService, PasskeyService, RateLimitService],
  exports: [AuthGuard, SuperAdminGuard, OAuthService, OtpService, PasskeyService, RateLimitService],
})
export class AuthModule {}

