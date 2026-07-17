import { Module } from '@nestjs/common';
import { ForumController, GroveEnabledGuard } from './forum.controller';
import { ForumService } from './forum.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [PrismaModule, UsersModule],
  controllers: [ForumController],
  providers: [ForumService, GroveEnabledGuard],
})
export class ForumModule {}
