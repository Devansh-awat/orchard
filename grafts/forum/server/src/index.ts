import { Module } from '@nestjs/common';
import { ForumController } from './forum.controller';
import { ForumService } from './forum.service';

@Module({
  controllers: [ForumController],
  providers: [ForumService]
})
export default class ForumModule {}
