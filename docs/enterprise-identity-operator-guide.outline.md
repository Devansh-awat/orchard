# Enterprise identity operator guide (outline)

## Concepts

- Instance providers vs org providers
- Platform switch vs owner switch
- Rules, default role, deny-unmapped, sync on login
- Identity is issuer+subject, not email

## Instance admin: single-company instance

- Add an instance provider (admin/sso)
  - OIDC (openid-client): issuer, client id/secret, scopes incl. groups
  - SAML (node-saml): entry point, IdP entity ID, certificate or metadata URL
- Set the groups claim name
- Create group rules
  - Group value -> org + role
  - Auto-create org (optional)
  - Instance-admin rule (off by default)
- Turn deny-unmapped on after dry-run testing
- Enforce SSO instance-wide; keep a break-glass superadmin
- Upgrading: pinned library versions (node-saml, xml-crypto, xmldom), `pnpm audit` gate, how to read advisories

## Instance admin: multi-org host

- Enable SSO per org (platformEnabled); revoke it
- Review audit entries
- What an org IdP can never do (invariants)
- Egress rules: internal IdP opt-out (`SSO_ALLOW_INTERNAL_IDP`)

## Org owner

- Verify domains (DNS TXT `_orchard-challenge.<domain>`)
- Add provider (OIDC/SAML); IdP-initiated is off
- JIT on/off, default role
- Rules: admin, member, guest, project-scoped; dry-run tester
- Enforcement (verify first; owners exempt)
- SCIM (SCIMMY-backed): token, base URL, push users and groups, rotate/expire
- Break-glass owner account
- Audit log

## IdP notes

- Okta
  - groups claim filter on the ID token; thin tokens, use userinfo
  - SAML group attribute statement; SCIM app, push groups
- Entra ID
  - groups claim carries object IDs; overage at 150 (SAML) / 200 (JWT)
  - restrict to assigned groups; security groups only
- Google Workspace
  - SAML app with group membership mapping; no OIDC groups claim by default
- Keycloak
  - group membership mapper (full path off); SAML attribute mapper
- LDAP/AD
  - front with Dex or Keycloak (supported path)
  - native ldapts bind (optional, Phase 6): LDAPS/StartTLS, service account, search base

## Troubleshooting

- sso_link_required
- Email not verified; domain not allowed
- No mapping -> denied
- Clock skew, certificate rotation
- Owner lockout recovery
