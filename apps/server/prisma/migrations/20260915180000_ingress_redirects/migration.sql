ALTER TABLE "ingresses"
ADD COLUMN "redirect_target" VARCHAR(2048),
ADD COLUMN "redirect_status" INTEGER,
ADD CONSTRAINT "ingresses_redirect_status_check"
CHECK ("redirect_status" IS NULL OR "redirect_status" IN (301, 302, 307, 308));
