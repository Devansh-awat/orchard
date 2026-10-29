import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { HarborScanClient } from './harbor-scan.client';
import { SecurityService } from './security.service';
import { SecurityController } from './security.controller';

@Module({
  imports: [PrismaModule, AuthModule, ProjectsModule],
  controllers: [SecurityController],
  providers: [HarborScanClient, SecurityService],
  exports: [SecurityService]
})
export class SecurityModule {}
