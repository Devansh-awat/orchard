import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { SandboxLimitsController } from './admin/sandbox-limits.controller';
import { SandboxesModule } from './sandboxes/sandboxes.module';
import { SandboxIntegrationsModule } from './sandboxes/integrations/sandbox-integrations.module';
import { SshIdentitiesModule } from './ssh-identities/ssh-identities.module';

@Module({
  imports: [CoreModule, SandboxesModule, SandboxIntegrationsModule, SshIdentitiesModule],
  controllers: [SandboxLimitsController]
})
export default class GreenhouseModule {}
