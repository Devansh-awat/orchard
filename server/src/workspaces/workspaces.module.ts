import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';
import { WorkspacesController } from './workspaces.controller';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [UsersModule, AuthModule],
  providers: [WorkspacesService],
  controllers: [WorkspacesController],
})
export class WorkspacesModule {}

