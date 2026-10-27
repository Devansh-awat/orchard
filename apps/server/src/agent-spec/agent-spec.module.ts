import { Module } from '@nestjs/common';
import { AgentSpecController } from './agent-spec.controller';

@Module({ controllers: [AgentSpecController] })
export class AgentSpecModule {}
