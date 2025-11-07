import { Module } from '@nestjs/common';
import { DockerController } from './docker.controller';
import { DockerService } from './docker.service';
import { ImageBuilderService } from './image-builder.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [DockerController],
  providers: [DockerService, ImageBuilderService],
  exports: [DockerService, ImageBuilderService],
})
export class DockerModule {}

