import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { SshIdentitiesController } from './ssh-identities.controller';
import { SshIdentitiesService } from './ssh-identities.service';

@Module({
  imports: [AuthModule, PrismaModule, UsersModule],
  controllers: [SshIdentitiesController],
  providers: [SshIdentitiesService],
  exports: [SshIdentitiesService],
})
export class SshIdentitiesModule {}
