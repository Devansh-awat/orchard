import { Module } from '@nestjs/common';
import { ForumController, GroveEnabledGuard } from './forum.controller';
import { ForumService } from './forum.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [PrismaModule, UsersModule, OrganizationsModule],
  controllers: [ForumController],
  providers: [ForumService, GroveEnabledGuard]
})
export class ForumModule {}
