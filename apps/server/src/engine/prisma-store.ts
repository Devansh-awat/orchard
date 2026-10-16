import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EngineRefs, EngineRow, EngineStore, RemovedRow, StoredRow } from './core/store';

const REF_COLUMNS = ['deploymentId', 'projectId', 'databaseId', 'jobId'] as const;

function refsOf(row: Record<(typeof REF_COLUMNS)[number], string | null>): EngineRefs {
  const refs: EngineRefs = {};
  for (const key of REF_COLUMNS) refs[key] = row[key];
  return refs;
}

export class PrismaEngineStore implements EngineStore {
  constructor(private readonly prisma: PrismaService) {}

  async load(shard: string, kind: string): Promise<StoredRow[]> {
    const rows = await this.prisma.k8sObject.findMany({
      where: { shard, kind },
      select: {
        uid: true,
        resourceVersion: true,
        derivedVersion: true,
        deploymentId: true,
        projectId: true,
        databaseId: true,
        jobId: true
      }
    });
    return rows.map((row) => ({
      uid: row.uid,
      resourceVersion: row.resourceVersion,
      derivedVersion: row.derivedVersion,
      refs: refsOf(row)
    }));
  }

  async write(rows: EngineRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ref = (r: EngineRow, key: (typeof REF_COLUMNS)[number]) => r.refs[key] ?? null;
    // `k8s_objects` is keyed by uid but also carries a unique index on the
    // natural key. Deleting a resource and recreating it under the same name
    // yields a new uid for the same natural key, so the upsert-by-uid alone
    // would trip that index and wedge the informer. Clear the displaced row in
    // the same transaction as the insert.
    const naturalKeys = Prisma.join(
      rows.map(
        (r) =>
          Prisma.sql`(${r.kind}::varchar, ${r.namespace}::varchar, ${r.name}::varchar, ${r.apiVersion}::varchar, ${r.uid}::varchar)`
      )
    );
    const values = Prisma.join(
      rows.map(
        (r) => Prisma.sql`(
          ${r.uid}::varchar, ${r.apiVersion}::varchar, ${r.kind}::varchar, ${r.namespace}::varchar,
          ${r.name}::varchar, ${r.resourceVersion}::varchar, ${r.derivedVersion}::varchar,
          ${r.shard}::varchar,
          ${JSON.stringify(r.manifest)}::jsonb, ${ref(r, 'deploymentId')}::uuid,
          ${ref(r, 'projectId')}::uuid, ${ref(r, 'databaseId')}::uuid, ${ref(r, 'jobId')}::uuid,
          (NOW() AT TIME ZONE 'UTC')
        )`
      )
    );

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        DELETE FROM "k8s_objects" AS o
        USING (VALUES ${naturalKeys}) AS v("kind", "namespace", "name", "api_version", "uid")
        WHERE o."kind" = v."kind"
          AND o."namespace" = v."namespace"
          AND o."name" = v."name"
          AND o."api_version" = v."api_version"
          AND o."uid" <> v."uid"
      `,
      this.prisma.$executeRaw`
        INSERT INTO "k8s_objects" (
          "uid", "api_version", "kind", "namespace", "name", "resource_version",
          "derived_version", "shard",
          "manifest", "deployment_id", "project_id", "database_id", "job_id", "synced_at"
        )
        VALUES ${values}
        ON CONFLICT ("uid") DO UPDATE SET
          "api_version" = EXCLUDED."api_version",
          "kind" = EXCLUDED."kind",
          "namespace" = EXCLUDED."namespace",
          "name" = EXCLUDED."name",
          "resource_version" = EXCLUDED."resource_version",
          "derived_version" = EXCLUDED."derived_version",
          "shard" = EXCLUDED."shard",
          "manifest" = EXCLUDED."manifest",
          "deployment_id" = EXCLUDED."deployment_id",
          "project_id" = EXCLUDED."project_id",
          "database_id" = EXCLUDED."database_id",
          "job_id" = EXCLUDED."job_id",
          "synced_at" = EXCLUDED."synced_at"
      `
    ]);
  }

  async markDerived(entries: { uid: string; resourceVersion: string }[]): Promise<void> {
    if (entries.length === 0) return;
    const uids = entries.map((e) => e.uid);
    const versions = entries.map((e) => e.resourceVersion);
    // Matching on resource_version too, so a newer manifest that landed while
    // the handler ran is not credited with a derivation it never got.
    await this.prisma.$executeRaw`
      UPDATE "k8s_objects" AS o
      SET "derived_version" = v."rv"
      FROM unnest(${uids}::varchar[], ${versions}::varchar[]) AS v("uid", "rv")
      WHERE o."uid" = v."uid" AND o."resource_version" = v."rv"
    `;
  }

  async remove(uid: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "k8s_objects" WHERE "uid" = ${uid}`;
  }

  // `= ANY($1)` binds the whole set as a single array parameter — an
  // `IN (...)` list would bind one parameter per object and fall off the
  // 65535-parameter cliff on a large cluster.
  async sweep(shard: string, kind: string, seenUids: string[]): Promise<RemovedRow[]> {
    return this.prisma.$queryRaw<RemovedRow[]>`
      DELETE FROM "k8s_objects"
      WHERE "shard" = ${shard}
        AND "kind" = ${kind}
        AND NOT ("uid" = ANY(${seenUids}::varchar[]))
      RETURNING "uid", "manifest"
    `;
  }
}
