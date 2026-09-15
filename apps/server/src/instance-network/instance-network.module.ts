import { Global, Module } from '@nestjs/common';
import { DnsCheckService } from './dns-check.service';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';
import { InstanceNetworkController } from './instance-network.controller';

// Global so the setup checklist can report DNS without importing this module,
// the same reason InstanceConfigModule is.
@Global()
@Module({
  controllers: [InstanceNetworkController],
  providers: [DnsCheckService, CloudflareTunnelService],
  exports: [DnsCheckService, CloudflareTunnelService]
})
export class InstanceNetworkModule {}
