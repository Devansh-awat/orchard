ALTER TABLE "organizations" ALTER COLUMN "backup_r2_secret_key" TYPE TEXT;
ALTER TABLE "git_connections" ALTER COLUMN "webhook_secret" TYPE TEXT;
ALTER TABLE "ingresses" ALTER COLUMN "protection_bypass_secret" TYPE TEXT;
ALTER TABLE "databases" ALTER COLUMN "db_password" TYPE TEXT;
