import { Module } from '@nestjs/common';
import { GraftsController } from './grafts.controller';

@Module({ controllers: [GraftsController] })
export class GraftsModule {}
