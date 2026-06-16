-- H-6: Track whether a user's email ownership has been proven (via OTP
-- verification or OAuth). Invitation acceptance is now gated on this flag so
-- an attacker cannot register an unverified account under a victim's address
-- and silently inherit pending organization invitations.

ALTER TABLE "users" ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(6);

-- Backfill: existing accounts predate this column. We can't reconstruct OTP
-- history, so to avoid locking current users out of accepting invitations we
-- grandfather every pre-migration row as verified. Only NEW signups after this
-- migration start unverified and must complete OTP/OAuth to flip the flag.
UPDATE "users" SET "email_verified" = true, "email_verified_at" = NOW();
