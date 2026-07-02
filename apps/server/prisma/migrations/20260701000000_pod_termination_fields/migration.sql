ALTER TABLE "pods" ADD COLUMN "ready" BOOLEAN;
ALTER TABLE "pods" ADD COLUMN "last_termination_reason" VARCHAR(100);
ALTER TABLE "pods" ADD COLUMN "last_exit_code" INTEGER;
ALTER TABLE "pods" ADD COLUMN "last_terminated_at" TIMESTAMP(6);
