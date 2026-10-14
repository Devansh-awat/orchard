import { Controller, Get, Inject } from '@nestjs/common';
import { Auth } from '../auth/decorators';
import { joinRoutePath } from '../auth/route-classifier';
import { graftRecords, loadedGrafts } from './graft-registry';
import { GRAFT_DOORS, GRAFT_SDK_VERSION, platformVersion } from './host-api';
import { PrismaService } from '../prisma/prisma.service';
import { graftPoolSize, measureDbBudget } from './db-budget';
import { GraftDbPools } from './db-pools';
import { trustPolicyFromEnv } from './integrity';

@Controller()
export class GraftsController {
  constructor(
    @Inject(GraftDbPools) private readonly pools: GraftDbPools,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  @Get('admin/grafts')
  async list() {
    const pools = this.pools.usage();
    const database = await measureDbBudget(
      async (sql) => ({ rows: await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql) }),
      graftRecords()
    ).catch(() => null);
    return {
      platform: platformVersion(),
      database,
      sdk: GRAFT_SDK_VERSION,
      trust: trustPolicyFromEnv(),
      doors: GRAFT_DOORS,
      grafts: graftRecords().map((r) => ({
        id: r.id,
        status: r.status,
        phase: r.phase ?? null,
        reason: r.reason ?? null,
        warnings: r.warnings,
        name: r.manifest?.name ?? r.id,
        version: r.manifest?.version ?? null,
        publisher: r.manifest?.publisher ?? null,
        description: r.manifest?.description ?? null,
        engines: r.manifest?.engines ?? null,
        uses: r.manifest?.uses ?? {},
        capabilities: r.manifest?.capabilities ?? [],
        permissions: r.manifest?.permissions ?? {},
        coreReads: r.manifest?.database.coreReads ?? {},
        adopts: r.manifest?.database.adopts ?? [],
        signature: r.signature ?? null,
        claims: r.claims ?? [],
        routes: (r.routes ?? []).map((route) => ({
          method: route.method,
          path: joinRoutePath('apiv1', r.id, route.path),
          classification: route.classification
        })),
        migrationsApplied: r.migrationsApplied ?? [],
        dbRole: r.dbRole ?? null,
        dbPool: pools[r.id] ?? null,
        dbPoolSize: r.manifest?.capabilities.includes('db') ? graftPoolSize(r) : null,
        settings: r.manifest?.settings ?? []
      }))
    };
  }

  @Get('grafts')
  @Auth()
  installed() {
    return loadedGrafts().map((r) => ({
      id: r.id,
      name: r.manifest!.name,
      version: r.manifest!.version,
      ui:
        r.manifest!.entries.ui && r.uiDigest
          ? { digest: r.uiDigest, screens: r.manifest!.ui.screens }
          : null
    }));
  }
}
