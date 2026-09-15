import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DnsCheckService } from './dns-check.service';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';

// Superadmin-only (default-deny: no @Auth()/@Public() decorator, so the global
// SuperAdminGuard requires a superadmin).
@Controller('admin/networking')
export class InstanceNetworkController {
  constructor(
    private readonly dns: DnsCheckService,
    private readonly tunnel: CloudflareTunnelService
  ) {}

  @Get('dns')
  dnsReport(@Query('refresh') refresh?: string) {
    return this.dns.report(refresh === 'true');
  }

  @Get('tunnel')
  tunnelState() {
    return this.tunnel.state();
  }

  @Post('tunnel/routes')
  async route(@Body() body: { hostname?: string }) {
    const state = await this.tunnel.route(String(body?.hostname ?? ''));
    await this.dns.report(true);
    return state;
  }
}
