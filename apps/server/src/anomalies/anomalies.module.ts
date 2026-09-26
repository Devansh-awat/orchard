import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { AnomaliesService } from './anomalies.service';
import { AnomaliesController } from './anomalies.controller';

@Module({
  imports: [PrismaModule, AuthModule, forwardRef(() => ProjectsModule)],
  controllers: [AnomaliesController],
  providers: [AnomaliesService],
  exports: [AnomaliesService]
})
export class AnomaliesModule {}
