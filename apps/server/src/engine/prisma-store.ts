import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { EngineRefs, EngineRow, EngineStore, StoredRow, Tombstone } from './core/store';

export const CLUSTER_IDENTITY_NAMESPACE = 'kube-system';

const REF_COLUMNS = ['deploymentId', 'projectId', 'databaseId', 'jobId'] as const;

function refsOf(row: Record<(typeof REF_COLUMNS)[number], string | null>): EngineRefs {
  const refs: EngineRefs = {};
  for (const key of REF_COLUMNS) refs[key] = row[key];
  return refs;
}

export class PrismaEngineStore implements EngineStore {
  constructor(private readonly prisma: PrismaService) {}

  async listStart(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ ts: string }[]>`
      SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS "ts"
    `;
    return rows[0]?.ts ?? '1970-01-01 00:00:00';
  }

  async current(entries: { uid: string; resourceVersion: string }[]): Promise<Set<string>> {
    if (entries.length === 0) return new Set();
    const uids = entries.map((e) => e.uid);
    const versions = entries.map((e) => e.resourceVersion);
    const rows = await this.prisma.$queryRaw<{ uid: string }[]>`
      SELECT o."uid"
      FROM "k8s_objects" AS o
      JOIN unnest(${uids}::varchar[], ${versions}::varchar[]) AS v("uid", "rv")
        ON o."uid" = v."uid" AND o."resource_version" = v."rv"
    `;
    return new Set(rows.map((r) => r.uid));
  }

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

  async write(rows: EngineRow[], since?: string): Promise<void> {
    if (rows.length === 0) return;
    const cutoff = since ? Prisma.sql`${since}::timestamp` : Prisma.sql`'infinity'::timestamp`;
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
    const uids = rows.map((r) => r.uid);

    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        DELETE FROM "k8s_objects" AS o
        USING (VALUES ${naturalKeys}) AS v("kind", "namespace", "name", "api_version", "uid")
        WHERE o."kind" = v."kind"
          AND o."namespace" = v."namespace"
          AND o."name" = v."name"
          AND o."api_version" = v."api_version"
          AND o."uid" <> v."uid"
          AND o."synced_at" < ${cutoff}
      `,
      this.prisma.$executeRaw`
        INSERT INTO "k8s_objects" (
          "uid", "api_version", "kind", "namespace", "name", "resource_version",
          "derived_version", "shard",
          "manifest", "deployment_id", "project_id", "database_id", "job_id", "synced_at"
        )
        SELECT v.*
        FROM (VALUES ${values}) AS v(
          "uid", "api_version", "kind", "namespace", "name", "resource_version",
          "derived_version", "shard",
          "manifest", "deployment_id", "project_id", "database_id", "job_id", "synced_at"
        )
        WHERE NOT EXISTS (
          SELECT 1 FROM "k8s_object_tombstones" AS t
          WHERE t."uid" = v."uid" AND t."buried_at" >= ${cutoff}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "k8s_objects" AS o
          WHERE o."kind" = v."kind"
            AND o."namespace" = v."namespace"
            AND o."name" = v."name"
            AND o."api_version" = v."api_version"
            AND o."uid" <> v."uid"
        )
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
        WHERE "k8s_objects"."synced_at" < ${cutoff}
      `,
      this.prisma.$executeRaw`
        DELETE FROM "k8s_object_tombstones"
        WHERE "uid" = ANY(${uids}::varchar[]) AND "buried_at" < ${cutoff}
      `
    ]);
  }

  async markDerived(
    entries: { uid: string; resourceVersion: string; derivedVersion: string }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const uids = entries.map((e) => e.uid);
    const versions = entries.map((e) => e.resourceVersion);
    const marks = entries.map((e) => e.derivedVersion);
    // Matching on resource_version too, so a newer manifest that landed while
    // the handler ran is not credited with a derivation it never got.
    await this.prisma.$executeRaw`
      UPDATE "k8s_objects" AS o
      SET "derived_version" = v."mark"
      FROM unnest(${uids}::varchar[], ${versions}::varchar[], ${marks}::varchar[])
        AS v("uid", "rv", "mark")
      WHERE o."uid" = v."uid" AND o."resource_version" = v."rv"
    `;
  }

  async bury(
    shard: string,
    kind: string,
    obj: { uid: string; manifest: unknown },
    keepTombstone: boolean
  ): Promise<void> {
    const remove = this.prisma
      .$executeRaw`DELETE FROM "k8s_objects" WHERE "uid" = ${obj.uid} AND "shard" = ${shard}`;
    if (!keepTombstone) {
      await remove;
      return;
    }
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO "k8s_object_tombstones" ("uid", "shard", "kind", "manifest", "buried_at")
        VALUES (
          ${obj.uid}, ${shard}, ${kind}, ${JSON.stringify(obj.manifest)}::jsonb,
          (NOW() AT TIME ZONE 'UTC')
        )
        ON CONFLICT ("uid") DO UPDATE SET "manifest" = EXCLUDED."manifest"
      `,
      remove
    ]);
  }

  // `= ANY($1)` binds the whole set as a single array parameter: an
  // `IN (...)` list would bind one parameter per object and fall off the
  // 65535-parameter cliff on a large cluster.
  async buryMissing(
    shard: string,
    kind: string,
    seenUids: string[],
    keepTombstones: boolean,
    retryAfterMs: number,
    since: string
  ): Promise<Tombstone[]> {
    if (!keepTombstones) {
      return this.prisma.$queryRaw<Tombstone[]>`
        DELETE FROM "k8s_objects"
        WHERE "shard" = ${shard}
          AND "kind" = ${kind}
          AND NOT ("uid" = ANY(${seenUids}::varchar[]))
        AND "synced_at" < ${since}::timestamp
        RETURNING "uid", "manifest"
      `;
    }
    const retrySeconds = Math.max(0, Math.round(retryAfterMs / 1000));
    const results = await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO "k8s_object_tombstones" ("uid", "shard", "kind", "manifest", "buried_at")
        SELECT "uid", "shard", "kind", "manifest", (NOW() AT TIME ZONE 'UTC')
        FROM "k8s_objects"
        WHERE "shard" = ${shard}
          AND "kind" = ${kind}
          AND NOT ("uid" = ANY(${seenUids}::varchar[]))
          AND "synced_at" < ${since}::timestamp
        ON CONFLICT ("uid") DO NOTHING
      `,
      this.prisma.$executeRaw`
        DELETE FROM "k8s_objects"
        WHERE "shard" = ${shard}
          AND "kind" = ${kind}
          AND NOT ("uid" = ANY(${seenUids}::varchar[]))
          AND "synced_at" < ${since}::timestamp
      `,
      this.prisma.$executeRaw`
        DELETE FROM "k8s_object_tombstones"
        WHERE "shard" = ${shard}
          AND "kind" = ${kind}
          AND "uid" = ANY(${seenUids}::varchar[])
      `,
      this.prisma.$queryRaw<Tombstone[]>`
        SELECT "uid", "manifest"
        FROM "k8s_object_tombstones"
        WHERE "shard" = ${shard}
          AND "kind" = ${kind}
          AND (
            "buried_at" = (NOW() AT TIME ZONE 'UTC')
            OR "buried_at" < (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${retrySeconds}::double precision)
          )
        ORDER BY "buried_at"
      `
    ]);
    return results[3] as Tombstone[];
  }

  async forget(uid: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "k8s_object_tombstones" WHERE "uid" = ${uid}`;
  }

  async dropForeignMirror(clusterUid: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const foreign = await tx.$executeRaw`
          DELETE FROM "k8s_objects"
          WHERE "kind" = 'Namespace'
            AND "api_version" = 'v1'
            AND "namespace" = ''
            AND "name" = ${CLUSTER_IDENTITY_NAMESPACE}
            AND "uid" <> ${clusterUid}
        `;
        if (foreign === 0) return false;
        await tx.k8sObject.deleteMany({});
        await tx.k8sObjectTombstone.deleteMany({});
        await tx.k8sWorkload.deleteMany({});
        await tx.k8sMirrorHeartbeat.deleteMany({});
        return true;
      },
      { timeout: 120_000 }
    );
  }
}
