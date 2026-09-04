-- HTTP Basic auth as a protection mode, enforced by the Orchard protection
-- proxy rather than a CiliumEnvoyConfig, so it works on any CNI. `basic` is
-- appended after `none` in declaration order only for readability; nothing
-- compares these values by ordinal.
ALTER TYPE "ingress_protection_mode" ADD VALUE IF NOT EXISTS 'basic';

-- The Envoy filter carried the username inline in its htpasswd string, so it
-- was never persisted. The proxy has to check it against the request.
ALTER TABLE "ingresses" ADD COLUMN IF NOT EXISTS "protection_username" VARCHAR(255);
