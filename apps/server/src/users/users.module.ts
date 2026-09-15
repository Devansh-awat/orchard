import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { EmailAvatarService } from './email-avatar.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [UsersService, EmailAvatarService],
  exports: [UsersService, EmailAvatarService]
})
export class UsersModule {}
