# Enterprise identity design: SSO, JIT, group mapping, SCIM, LDAP

Status: proposal, written against `main` at 88b65059. No product code changes. Principle: library-first. Custom code is limited to thin glue and the policy layer (rules, tenancy invariants, audit).

## Implementation status (feat/enterprise-identity-p1 and p2)

Owner decisions (final): rules never grant `owner` (cap admin); deny when an IdP has rules and the user matches none; roles re-sync on every login; IdP-initiated SAML is tier 1 only (app tile points at `/apiv1/sso/start/:providerId`, unsolicited responses stay rejected); instance IdP auto-create of orgs is a later, default-off setting; LDAP is bridge-only (Dex/Keycloak).

Shipped in the first slice (design phases 1 and 2, plus the org-targeted part of phase 4):

- `FederatedIdentity (providerId, subject, userId)`, bound on first login and matched ahead of email afterward; a different subject for an already-bound account is refused.
- `IdpGroupRule (providerId, organizationId, value, role)` and `IdentityProvider.groupClaim`; `OrganizationMember.managedByProviderId` marks memberships a rule created or last changed. Differences from the sketch above: no `denyUnmapped`/`syncOnLogin`/`maxRole` columns (the decisions make them constants), `grantedByRuleId` became a provider-level marker, and rule ids are recorded in audit entries instead.
- `sso/group-rules.ts`: pure NFC + case-sensitive exact-match resolver, bounded claim extraction (500 groups, 16 KB, 256-character names, overage markers mean unknown), no regex or expression language.
- `IdentityMappingService`: shared by org and instance providers; denies, provisions, re-roles and removes; revokes SSO sessions, org-scoped API tokens and membership cache entries on downgrade and removal; audits `sso.login.denied`, `sso.member.provisioned|role_synced|removed`, `sso.identity.bound`, `sso.rules.updated`.
- Routes: `GET|PUT organizations/:id/sso/providers/:providerId/rules`, `POST .../rules/preview`, and the same under `admin/sso/providers/:providerId/rules` (instance rules name a target organization).
- Instance providers: a rule match counts as signup access; superadmins are exempt from deny and never changed by rules.

Shipped in the second slice (`feat/enterprise-identity-p2`):

- **SCIM Groups write (phase 3).** `ScimGroup` and `ScimGroupMember` (both carry `organizationId`, cascade on org and user delete) hold the pushed directory. POST, PUT, PATCH and DELETE on `Groups` go through SCIMMY's ingress and degress hooks in `scim-groups.service.ts`. Member values must be SCIM user ids of the token's organization (live or deactivated), so a token cannot enrol or read another org's people. A change re-evaluates only the users it touched against the org's `IdpGroupRule`s with the same resolver as login (`IdentityMappingService.syncDirectoryChanges`): a grant or upgrade applies, and a removal happens only when the change took away the last matching SCIM group, only for memberships a rule created or changed, never for owners, and never creating a membership (a tombstoned user gets nothing until reactivated). At login the claim groups and the user's directory groups are unioned per org before the resolver runs. The four `role:*` groups stay read-only (400 `mutability`). SCIM deactivate and DELETE now also revoke the user's SSO sessions and org-scoped API tokens, and DELETE drops group links; the earlier stale-owner tombstone cap (reactivation never restores `owner`) is untouched.
- **Instance-level organization creation and the superadmin rule (phase 4).** `IdpAutoCreateRule (providerId, value, role, organizationId?)` and `FederatedIdentity.grantedSuperadmin`. Both features are controlled only through `admin/sso/*` (the global superadmin guard) and neither reads anything from an org IdP. `IDP_AUTO_CREATE_ORGS` / instance setting `idp_auto_create_orgs` is the switch, default off and pinnable by env. When it is on and a login on an instance provider matches an auto-create rule that has no organization yet, one transaction creates the organization (default caps, reserved-slug and collision safe, no owner), claims the rule with a conditional update so a race creates at most one, and inserts an ordinary `IdpGroupRule` for it; every later login uses the normal resolver. Rules still cap at admin. The superadmin rule is two instance settings (`idp_superadmin_provider_id`, `idp_superadmin_group`): at an instance-provider login with a verified email and a bound identity, a matching group sets `isSuperAdmin` and marks the identity; losing the group revokes only marked grants, never the last superadmin, then revokes SSO sessions. Clearing or moving the rule, or deleting the provider, demotes everyone it granted. Audit: `admin.sso.auto_create_orgs_toggled`, `sso.auto_create_rules.updated`, `sso.org.auto_created`, `org.created`, `admin.sso.superadmin_rule_updated`, `sso.superadmin.granted|revoked`.
- **Rules UI.** `GroupRulesEditor` (org SSO tab and the instance admin Sign in page, with the preview endpoint, duplicate and missing-org validation, the `sso_not_mapped` and wrong-claim explanations) and `InstanceIdentityPolicy` (switch, organization-from-group rules, superadmin group). The instance OAuth callback page now words `sso_not_mapped`.
- **OIDC end to end (`oidc-callback.test.ts`).** A fake issuer on loopback (discovery, JWKS and token endpoints, requests rewritten through the `fetchIdp` seam so the client still sees an https issuer) drives `startOidc` and `handleOidcCallback` into the real `completeLogin`, mapping and resolver. It covers provisioning, dotted claim paths, deny-on-no-match, overage, demotion and removal on the next login, owner exemption, wrong issuer, audience, nonce, expiry, unverified email, and single-use state. Finding: `openid-client` 6 does not verify the ID token signature when the token arrives from the token endpoint (OIDC Core 3.1.3.7 allows skipping it over TLS), so a token signed by another key was accepted. `handleOidcCallback` now verifies the signature against the provider's `jwks_uri` (fetched through the SSRF-guarded client, asymmetric algorithms only, issuer and audience checked again); `HS*` tokens keep the library's behaviour.
- **`pnpm audit --prod` gate (phase 0 remainder).** CI job `audit` runs when a manifest, the lockfile or the workflows change. Today's three advisories (`request` GHSA-p8p7-x288-28g6, `uuid` GHSA-w5hq-g745-h8pq, `deepmerge` GHSA-gcqx-w48m-w2h4, all transitive through `@kubernetes/client-node`) are allow-listed in `pnpm-workspace.yaml` `auditConfig.ignoreGhsas`. None touches the SAML, XML, OIDC or JOSE packages.

Not shipped: project-level bindings, CLI commands and Tofu resources for rules (every other SSO route is deliberately web-UI only, see `parity_test.go`, and a rules resource would need a provider that Tofu cannot create), native LDAP (phase 6).

**Phase 0 result (2026-11-08).** Bumped `@node-saml/node-saml` 5.1.0 to 5.2.0 (exact pin kept), which pulls `xml-crypto` 6.1.2 to 6.4.0, `@xmldom/xmldom` stays 0.8.15 (already forced by the existing override), `xpath` 0.0.35; `openid-client` 6.8.2 to 6.8.9 (`oauth4webapi` 3.8.8, `jose` 6.2.15 for its own use); app `jose` stays 5.10.0 (latest 5.x). No new overrides were needed. Read from the 5.2.0 package source and release notes: the library now also checks the Response `Issuer` against `idpIssuer` and rejects a message with more than one `Issuer`, can reject replayed assertion ids (`rejectReplayedAssertions`, off by default; we keep our own replay cache), enforces SubjectConfirmationData `NotOnOrAfter` in every InResponseTo mode, and reads status and InResponseTo from signed bytes only. It does **not** enforce Destination or Recipient: a mismatch only writes a `debuglog('node-saml')` warning, and the notes say the next major version will reject. `saml-response.ts` therefore stays authoritative for Destination, Recipient, InResponseTo, audience and issuer, with node-saml as defence in depth for issuer and audience; `saml-hardening.test.ts` pins both facts so a future bump that changes either shows up. 5.2.0 deprecates the unused `host` argument of `getAuthorizeUrlAsync` (call sites updated). `xml-crypto` 6.2.0 to 6.4.0 changed inclusive canonicalization output, added its own PEM parser and signed-reference tracking; no regression in the SAML suites. `pnpm audit --prod` reports nothing for the SAML, XML, OIDC or JOSE packages.

## 1. Current state (verified in code)

**Instance level.** `apps/server/src/sso/sso-instance.controller.ts` serves `admin/sso/*`: provider CRUD, `enforcement` get/patch, icon, `providers/:id/test`, and `organizations/:id` PATCH (flips `OrgSsoSettings.platformEnabled`). Providers with `organizationId = null` are instance providers, listed publicly by `GET sso/providers` (`sso.controller.ts`). Instance enforcement is the `sso_enforced` key (`instance-settings.service.ts`), checked by `assertInstanceSsoNotEnforced` (`auth/authorization.service.ts:225`); superadmins are exempt.

**Org level.** `sso-admin.controller.ts` (`organizations/:id/sso`): domains (add, DNS TXT verify, delete), `settings`, provider CRUD/icon/test. `OrgSsoSettings` has `platformEnabled` (operator, default off), `enabled` (owner), `enforced`, branding. `OrgDomain` verification uses TXT at `_orchard-challenge.<domain>`; a partial unique index lets only one org hold a verified domain. Login: `GET sso/org/:slug`, `sso/:orgId/login|callback`; the vanity subdomain only redirects. Owners are exempt from per-org enforcement.

**Schema** (`prisma/schema.prisma`): `IdentityProvider` (OIDC/OAuth2/SAML fields; `jitProvisioning`, `defaultRole`, `allowedDomains`, `requireVerifiedEmail`), `OrgSsoSettings`, `OrgDomain`, `ScimToken` (hashed, optional expiry), `ScimDeprovisionedMember`, `OrganizationMember` (role enum owner/admin/member/guest, `scimExternalId`, `scimManaged`), `ProjectMember`.

**Protocols.** OIDC/OAuth2 via `openid-client` (`sso-login.service.ts`, `handleOidcCallback`). SAML via `@node-saml/node-saml` 5.2.0 with `wantAssertionsSigned`, pinned `idpIssuer`, `ValidateInResponseTo.always`, plus our own `saml-response.ts` (size/depth/element caps, algorithm allowlist, Recipient/InResponseTo checks using regex tag scanning) and `saml-request.store.ts`. IdP-initiated responses are therefore rejected (Railway supports them; this is a deliberate gap). SCIM is built on the **SCIMMY** library (`scimmy` 1.3.5, `scim.service.ts`), not hand-rolled PATCH/filter parsing.

**Login semantics** (`completeLogin`, `resolveOrgUser`, `resolveInstanceUser`): email must be verified; `allowedDomains` enforced. Org SSO signs in an existing account only if the user is already a member, not a superadmin, and the email is in a verified domain or the sign-in was started from their own session (else `sso_link_required`). Existing owners may sign in only through a provider they created. JIT needs `jitProvisioning` and a verified domain; pending invites are honoured; otherwise the role is the static `provider.defaultRole`. Org sessions are confined to that org (`sessionOrgId`; `getOrgAccess` returns null elsewhere). Instance JIT is gated only by signup mode: no role or org assignment. The IdP `subject` is parsed (`IdpProfile.subject`) but never stored; identity is matched by email only. Admin-supplied IdP URLs pass an SSRF guard (`assertIdpUrl`, `sso.service.ts`).

**Groups and roles.** Nothing in `src/sso` reads a groups/roles claim. Role is set only at JIT and never re-evaluated. SCIM Users: full CRUD/PATCH/search; role via `roles`/`userType`; `owner` cannot be granted; last owner protected. SCIM **Groups are read-only** projections of the four roles (`role:admin`...); POST/PUT/PATCH/DELETE return **501** (`scim.controller.ts` `groupsAreReadOnly`, `scim.service.ts:189`). They map to nothing configurable.

**Deprovisioning.** SCIM `active:false`/DELETE deletes the `OrganizationMember`, writes a tombstone, calls `membershipCache.revoked`. I found no explicit session/API-token kill; access ends via the membership check. **LDAP:** none. **Tofu provider** (`apps/cli/tofu-provider/internal/provider`): no identity resources.

**Gaps:** no group/attribute to (org, role) mapping at either level; no instance routing into orgs; no per-login role sync; no stored subject; no project/guest mapping; SCIM Groups not writable; no LDAP; no IaC.

## 2. How others do it (official docs)

| Product              | Findings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Datadog              | JIT toggle + default role; role mapping, when on, overrides the JIT default and can leave users role-less ([saml](https://docs.datadoghq.com/account_management/saml/)). Case-sensitive attribute-to-role mappings applied at login; role removed when attribute goes; no match = roles lost and SAML login blocked; max 1,000; team mappings only provision ([mapping](https://docs.datadoghq.com/account_management/saml/mapping/)). Strict mode disables other login methods, with per-user overrides. SAML is per child org, not inherited; children are isolated ([multi-org](https://docs.datadoghq.com/account_management/multi_organization/)). |
| Vercel               | SAML (Enterprise, Pro add-on), owner-only; enforcement; editing config turns enforcement off; roles manual after JIT ([saml](https://vercel.com/docs/saml)). Directory Sync (Enterprise) maps directory groups to team roles, overwrites roles, removes deleted users; break-glass groups `vercel-role-owner` etc. ([directory-sync](https://vercel.com/docs/directory-sync)).                                                                                                                                                                                                                                                                          |
| Railway              | Workspace SAML, Enterprise; Trusted Domains first; SAML or OIDC; IdP-initiated supported; per-workspace enforcement ([docs](https://docs.railway.com/enterprise/saml), via search summary). Group/role mapping: not found.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GitHub               | One IdP group per team via SCIM; daily and on-change reconcile; unlinking removes users who joined only via that team ([docs](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups)).                                                                                                                                                                                                                                                                                                                                                     |
| GitLab               | Case-sensitive SAML group name to role; highest role wins; evaluated every sign-in; unmapped users removed ([docs](https://docs.gitlab.com/user/group/saml_sso/group_sync/)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Grafana              | `role_attribute_path`, `role_attribute_strict` (deny if unresolved), `skip_org_role_sync`, `org_mapping`; server admin only with `allow_assign_grafana_admin` ([docs](https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/)).                                                                                                                                                                                                                                                                                                                                                                 |
| Sentry               | JIT with org default role; no automatic deprovisioning; no attribute-to-role mapping on the page ([docs](https://docs.sentry.io/organization/authentication/sso/saml2/)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Okta / Entra         | Okta `groups` claim by Filter/Expression; thin tokens may omit groups ([docs](https://developer.okta.com/docs/guides/customize-tokens-groups-claim/main/)). Entra caps groups (150 SAML, 200 JWT) with an overage claim; identify by `oid`/`sub`, never email ([docs](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)).                                                                                                                                                                                                                                                                                            |
| Keycloak / Authentik | Not found (Keycloak page truncated, Authentik URL a parking page).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Common model:** IdP, claim/group, ordered rules, (org, role[, team]). Exact case-sensitive match; highest role wins; explicit default; strict deny-if-unmapped; re-evaluate each login plus SCIM for offline removal; instance admin never IdP-grantable by default; lockout escape hatch.

## 3. Library selection

Evidence date 2026-11-07: npm registry, npm weekly downloads (Oct 30 - Nov 5), GitHub advisory lists. "Not verified" means I did not read the source or advisory detail. All candidates below are MIT or Apache-2.0 (both AGPL-3.0 compatible).

**(1) SAML SP.** Candidates:

- `@node-saml/node-saml`: MIT, 2.0M/wk, 5.2.0 released 2026-10-26 (deps `xml-crypto ^6.4.0`, `@xmldom/xmldom ^0.8.15`), TypeScript, used by passport-saml. Advisories: 4 listed; two Critical in Jul 2025, including GHSA-4mxg-3p6v-xgq3 / CVE-2025-54419 (assertion read from the unsigned document), fixed in 5.1.0 (our pin is exactly the first safe version).
- `samlify`: MIT, 2.9M/wk, 2.15.1. Advisory page shows 10 entries dated 2026-05 to 2026-10, including a Critical (attacker-controlled signing cert via RSAKeyValue metadata, GHSA-w8r9-gp23-wcxp), missing InResponseTo (GHSA-wj54-2vfp-35f2) and missing AudienceRestriction (GHSA-wxh7-j2vx-w63f). **Rejected.** Patched versions not verified.
- `@boxyhq/saml-jackson`: Apache-2.0 core (enterprise features under a separate Ory license), 88K/wk, 26.2.0, embeddable as an npm library or service, SAML SSO plus SCIM directory sync; production adopters listed by Ory include OpenAI and Cisco. No audit statement found. Its per-check coverage: not verified. It wants its own DB store and tenancy model, which would duplicate our org/provider tables.
- Bridge (Keycloak/Dex/Authentik): strongest isolation of SAML parsing, but a second service per instance; not per-org self-service.

**Pick node-saml 5.2.0, runner-up Jackson (revisit if our glue exceeds ~300 lines).** node-saml covers signature verification (via xml-crypto), assertion-signed, audience, InResponseTo with a cache, timestamps with skew, and `idpIssuer`. Per the owner, it does not enforce Destination or Recipient/SubjectConfirmation on login responses. We still write: that check and the size/depth caps (`saml-response.ts`). Action item: replace the regex tag scanner with checks on the already-parsed document, or delete checks 5.2.0 now covers (verify by test).

**(2) OIDC.** `openid-client` (panva): MIT, 22.9M/wk, latest 6.8.9 (repo has ^6.8.2), ESM-only, deps `jose` + `oauth4webapi`, certified-profile oriented. `jose`: MIT, 225M/wk; repo uses ^5.2.0 for state/session JWTs, openid-client resolves its own jose 6. **Pick openid-client 6.8.9 + jose 5.10.x for our JWTs** (runner-up: `oauth4webapi` directly). ESM fit: already handled via dynamic import with `resolution-mode: import` in `sso-login.service.ts`. We still write: discovery pinning, nonce/PKCE state store, claim extraction.

**(3) SCIM v2.** Already `scimmy` 1.3.5 (88K/wk; MIT license per my recollection, not verified here). It covers resource schemas, filter parsing and PATCH application, and lets us implement Group ingress/egress, which is what removes the 501. `scim-patch` 0.9.3 (Unlicense, `scim2-parse-filter`) only applies PATCH ops to plain objects: redundant. Jackson directory sync: runner-up, rejected for duplicate data model. **Pick scimmy (pin latest 1.x after a changelog read).** We write: token auth, tenancy, role/group mapping to the rule resolver.

**(4) LDAP.** `ldapjs`: **archived 2024-05-14**, read-only, maintainer says decommissioned (verified on GitHub): rejected. `ldapts`: MIT, 731K/wk, 9.2.0, TypeScript, ESM+CJS exports, Node >=22, StartTLS, `escapeFilter`; referral handling not stated. **Pick ldapts 9.2.0 for Phase 6 only; runner-up the Dex/Keycloak bridge, which stays the supported default.**

**(5) Rule evaluation.** Candidates: JSONata (MIT, zero deps, 3.1M/wk, a full expression language, so unbounded recursion/CPU needs a hard timeout), JSONPath libraries, CEL, json-logic, Casbin (policy engines for other jobs). CEL/json-logic/Casbin/jsonpath: not evaluated. **Pick no library: a declarative table of exact-match rules** (`claimPath`, `value`, `role`) evaluated by a pure function over NFKC-normalised strings with size limits. No code execution, no regex, linear time. The only dynamic part, locating the groups claim, is a single dotted path or a literal key from an allowlist. Runner-up: JSONata for claim extraction only, behind a timeout, if customers need transforms.

**(6) XML security.** Pin via pnpm overrides: `xml-crypto >= 6.4.0` (installed lock is 6.1.2; GHSA-9p8x-f768-wp2g signature bypasses patched in 6.0.1, so 6.1.2 is not known-vulnerable, but 5.2.0 raises the floor), `@xmldom/xmldom >= 0.8.15` (installed 0.8.15; ReDoS GHSA-x4fp-j954-r2f4 affects 0.7.0 to 0.8.14; ten more advisories published 2026-08, patched versions not verified: re-check before pinning; 0.9.x not affected by that one). CI check: `pnpm audit` gate.

| Capability | Library                 | Pin               | Covers                                    | We still write              | Risk                             |
| ---------- | ----------------------- | ----------------- | ----------------------------------------- | --------------------------- | -------------------------------- |
| SAML SP    | node-saml (alt Jackson) | 5.2.0             | sig, audience, InResponseTo, time, issuer | Destination/Recipient, caps | Medium: history of critical bugs |
| OIDC       | openid-client + jose    | 6.8.9 / 5.10.x    | discovery, code+PKCE, ID token checks     | state store, claim use      | Low                              |
| SCIM       | scimmy                  | latest 1.x        | schemas, filter, PATCH                    | auth, mapping, Groups       | Low-Med                          |
| LDAP       | ldapts (alt bridge)     | 9.2.0             | bind, search, StartTLS, escape            | SSRF guard, policy          | High                             |
| Rules      | none (declarative)      | n/a               | n/a                                       | exact-match resolver        | Low                              |
| XML        | xml-crypto, xmldom      | >=6.4.0, >=0.8.15 | c14n, signatures                          | audit gate                  | Medium                           |

## 4. Proposed design

### 4a. Instance level (one company per instance)

Instance IdPs as today. Add rules `(provider, claimPath, value) -> (organization | autoCreate, role, project bindings)` evaluated each instance login. Per org, highest role wins; `owner` only via an explicit rule written by an instance admin. `denyUnmapped` per provider (default deny once any rule exists). Superadmin only through a separate `InstanceAdminRule`, off by default, writable only by a superadmin. Rule-granted memberships are tracked (`grantedByRuleId`) and removed when no longer matched.

### 4b. Org level (multi-org host)

Each owner configures providers, DNS-verified domains, JIT, rules (admin/member/guest, optionally project role), SCIM tokens, enforcement.

**Invariants** (each needs a test):

1. Org id always comes from `provider.organizationId`, never a claim.
2. No instance roles, ever; the superadmin refusal stays.
3. No org creation; no touching other orgs.
4. Rules cap at `admin`; `owner` needs an explicit per-rule opt-in; last owner protected.
5. No account creation or linking outside a verified domain, except the authenticated-link path.
6. Groups come only from the signature-verified assertion or the ID token validated against this provider; overage markers mean "unknown", never grant.
7. Role change or removal revokes sessions and API tokens for that org.
8. JIT and SCIM share one resolver, so they converge.
9. Every grant, change, removal and denial is audited with provider and rule ids.
10. `platformEnabled` AND `enabled` both required; config edits switch enforcement off until re-verified.
11. Store issuer+subject on first login; later logins match on it; email change never relinks.
12. IdP URLs keep the SSRF guard.

### 4c. Data, API, UI, IaC

Prisma (CLI-generated migrations only): `IdpGroupRule`, `FederatedIdentity (providerId, subject, userId)`, provider fields `groupClaim`, `denyUnmapped`, `syncOnLogin`, `maxRole`, `allowIdpInitiated=false`; `grantedByRuleId` on `OrganizationMember`/`ProjectMember`. Routes: `organizations/:id/sso/rules` CRUD + dry-run preview, `admin/sso/rules`; SCIM Groups via SCIMMY. Regenerate the auth-coverage snapshot, then contracts bootstrap/generate. UI: Rules tab in `[orgSlug]/settings` and `admin/sso`, with a sample-claims tester. Tofu: `orchard_identity_provider`, `orchard_sso_rule`, `orchard_org_domain`. Docs: `teams/sso.md`, `teams/scim.md`, `operate/instance-admin.mdx`.

### 4d. LDAP recommendation

Supported path: a SAML/OIDC bridge (Dex, Keycloak) in front of LDAP/AD. Native bind (`ldapts`) is optional, instance-level first, never per-org until an egress allowlist exists. If built: LDAPS/StartTLS with cert validation, existing SSRF guard on the host, service-account bind, `escapeFilter` on every value, bind-as-user, referrals off, timeouts, rate limits, depth-capped nested groups. Risk: Orchard becomes a password proxy to the customer's directory.

### 4e. Migration

All new fields default to today's behaviour; with no rules the login path is unchanged. hq-orchard has zero providers. `FederatedIdentity` backfills lazily at next login.

### 4f. Phases and threats

| Phase                                                                   | Size | Libraries             | Unlocks                |
| ----------------------------------------------------------------------- | ---- | --------------------- | ---------------------- |
| 0. Bump node-saml 5.2.0, xml-crypto/xmldom overrides, `pnpm audit` gate | S    | node-saml, xml-crypto | patched floor          |
| 1. FederatedIdentity, shared resolver, audit                            | M    | openid-client         | stable identity        |
| 2. Org rules, sync on login, deny-unmapped, revocation                  | L    | none                  | per-org role mapping   |
| 3. SCIM Groups write                                                    | M    | scimmy                | Okta/Entra push        |
| 4. Instance rules, auto-create orgs                                     | M    | none                  | single-company routing |
| 5. Tofu, CLI, docs                                                      | S    | none                  | IaC                    |
| 6. Native LDAP (optional)                                               | L    | ldapts                | direct AD              |

Tests: the planned isolation harness (two orgs plus a hostile IdP fake) per invariant; pure resolver tests; auth-coverage snapshot.

| Abuse case                     | Mitigation                                                |
| ------------------------------ | --------------------------------------------------------- |
| Evil org IdP asserts `admins`  | per-org rules, capped role, no cross-org or instance path |
| Forged group claim             | verified assertion/ID token only                          |
| IdP-initiated login            | rejected by default                                       |
| Stale membership               | `grantedByRuleId` sweep, SCIM, token revocation           |
| Group rename collision         | match stable group id where offered                       |
| Case/Unicode                   | NFKC then exact case-sensitive; reject mixed-script rules |
| Claim size                     | cap 500 groups / 16KB; overage never grants               |
| Same domain, several providers | one verifying org; highest role wins                      |
| IdP email change               | subject binding                                           |
| Rule flood                     | 1,000 rules per org                                       |

## 5. Decisions needed

1. Org rule granting `owner`? Recommend no. Default: no (cap admin).
2. Deny-unmapped once rules exist? Recommend yes. Default: yes.
3. Sync every login? Recommend yes. Default: yes for orgs with rules.
4. IdP-initiated SAML? Recommend no. Default: off.
5. Instance auto-create orgs / admin rule? Recommend gated auto-create, admin rule off. Default: off.
6. Native LDAP vs bridge? Recommend bridge first. Default: bridge only.
