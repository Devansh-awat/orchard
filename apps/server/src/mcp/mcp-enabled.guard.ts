import { CanActivate, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';

const TTL_MS = 10_000;

/**
 * The runtime kill switch for this process.
 *
 * `mcp.enabled` in the chart decides whether an MCP is deployed at all; this
 * decides whether the one that is deployed answers. Both matter: an operator
 * who turns MCP off in the admin panel expects live agent connections to stop
 * working, not to keep working until the next helm upgrade.
 *
 * Cached, because it guards every JSON-RPC call and a tool-heavy agent session
 * is a lot of requests to put a database round-trip in front of.
 */
@Injectable()
export class McpEnabledGuard implements CanActivate {
  private cached: { at: number; value: boolean } | null = null;

  constructor(private readonly settings: InstanceSettingsService) {}

  async canActivate(): Promise<boolean> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > TTL_MS) {
      this.cached = { at: now, value: await this.settings.isMcpEnabled() };
    }
    if (!this.cached.value) {
      throw new ServiceUnavailableException('MCP is off on this Orchard instance');
    }
    return true;
  }
}
