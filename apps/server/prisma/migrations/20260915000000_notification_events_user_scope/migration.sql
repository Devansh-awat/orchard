-- A security event is about one person's account, which belongs to no single
-- organization. Metadata-only in Postgres: no table rewrite.
ALTER TABLE "notification_events" ALTER COLUMN "organization_id" DROP NOT NULL;
