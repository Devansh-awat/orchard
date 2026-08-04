-- Consent reset. The first cut seeded a personal email destination with
-- enabled = true from a GET of the settings page, so anyone who merely opened
-- Settings -> Notifications was signed up for mail they never asked for.
--
-- Data only, so there is no schema delta for `prisma migrate diff` to produce.
-- Turning every existing personal email destination off is the safe direction:
-- anyone who does want mail can switch it back on, and nobody is mailed
-- because they once looked at a page.
UPDATE "user_notification_destinations"
SET "enabled" = false
WHERE "type" = 'email' AND "enabled" = true;
