import { Controller, Get, Req } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { EngineService } from './engine.service';
import { holdsSuperAdminPower, requestAuthStorage } from '../auth/request-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Auth()
@Controller('engine')
export class EngineHealthController {
  constructor(
    private readonly mirror: EngineService,
    private readonly prisma: PrismaService
  ) {}

  private async isSuperAdmin(req: any): Promise<boolean> {
    const sub = req?.user?.sub as string | undefined;
    if (!sub || !holdsSuperAdminPower(requestAuthStorage.getStore())) return false;
    const user = await this.prisma.user.findFirst({
      where: { OR: [...(UUID_RE.test(sub) ? [{ id: sub }] : []), { externalAuthId: sub }] },
      select: { isSuperAdmin: true }
    });
    return Boolean(user?.isSuperAdmin);
  }

  @Get('health')
  async health(@Req() req: any) {
    const full = await this.mirror.health();
    if (await this.isSuperAdmin(req)) return full;
    return {
      shards: [{ shard: 'cluster', holder: null, stale: full.shards.some((s) => s.stale) }],
      replicas: [] as string[],
      undelivered: 0
    };
  }
}
