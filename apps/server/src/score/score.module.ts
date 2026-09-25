import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GitModule } from '../git/git.module';
import { ProjectsModule } from '../projects/projects.module';
import { ScoreService } from './score.service';

@Module({
  imports: [PrismaModule, forwardRef(() => GitModule), forwardRef(() => ProjectsModule)],
  providers: [ScoreService],
  exports: [ScoreService]
})
export class ScoreModule {}
