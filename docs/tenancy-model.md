# Orchard tenancy model

Internal spec. It states, for each isolation boundary, the invariant, the mechanism that enforces it today, the configuration it depends on, what is not guaranteed, known gaps, and the test that proves it. Every file and function named here was read on this branch. Items marked `UNVERIFIED` were not confirmed against code or a live cluster.

Threat model: an evil organization, an evil project editor, an evil tenant workload, an evil build, an evil IdP, a leaked org-scoped token, a prompt-injected MCP client. Trusted: the instance operator, first-party grafts (see the note on grafts below), and a project editor for their own project only.

Principals: instance superadmin; org owner / admin / member / guest; project admin / member / viewer; API token (optionally project-scoped, optionally org-scoped); org-scoped IdP session (`sessionOrgId`); MCP gateway request; tenant workload (a pod in a tenant namespace); build pod; anonymous internet client.

Grafts are trusted by design. Graft code authority is out of scope here; only signature, revocation and labeling signals matter.

Machine-readable index: `docs/isolation-invariants.json`. Operator-facing summary: `apps/docs/src/content/docs/operate/tenancy-and-isolation.md`.

## Conventions

- Tenant namespace: `{org-slug}-{project-slug}-{6 hex}` (`ProjectsService.freshNamespace`, `apps/server/src/projects/projects.service.ts`), one per project environment (`EnvironmentsService.deconflictNamespace`). Labeled `orchard.my/managed=true`.
- Control-plane namespace: `orchard` (`Values.namespace`). Other platform namespaces: `orchard-builders`, `orchard-r2-proxy`, `orchard-metrics`, `orchard-scans`, `orchard-object-storage`, `orchard-sandboxes`, `orchard-fc-builders` (reserved in `ProjectsService.RESERVED_NAMESPACES`).

---

## I1. Organization to organization, control plane (API and database)

**Invariant.** A principal with no membership in org B cannot read, list, mutate or learn the existence of any resource of org B through any route, token, session or MCP request.

**Principals.** Any authenticated user, API token, org-scoped session, MCP gateway request.

**Mechanism.**
- Global guard `SuperAdminGuard.canActivate` (`apps/server/src/auth/superadmin.guard.ts`) authenticates every route that is not `@Public()`, and publishes the request auth context (`requestAuthStorage`, `apps/server/src/auth/request-context.ts`) with `tokenProjectIds` and `sessionOrgId`.
- `AuthorizationService.getOrgAccess` / `requireOrgMember` / `requireOrgAdmin` / `requireOrgOwner` (`apps/server/src/auth/authorization.service.ts`): non-members get `NotFoundException` (not 403), so existence is not disclosed. `getOrgAccess` returns `null` when `sessionOrgId` differs from the requested org (tenant confinement for IdP sessions).
- `AuthorizationService.resolveProjectAccess` / `requireProjectView` / `requireProjectEdit`: project access is derived from the project's own `organizationId`, so a project id from org B is a 404 for anyone outside B. A `ProjectMember` row without an `OrganizationMember` row grants nothing (orphan rule).
- `AuthorizationService.listVisibleProjectIds` and `ProjectAccessService.buildProjectAccessFilter` (`apps/server/src/projects/project-access.service.ts`) scope list endpoints.
- Route classification is snapshotted: `apps/server/test/auth-coverage.snapshot.json` (683 routes: 516 authenticated, 98 superadmin, 69 public). A new or reclassified route fails the test until the snapshot is reviewed.
- Superadmin bypass is explicit (`source: 'superadmin'`); `requirePhysicalOrgMembership` exists for actions that must not be satisfied by a superadmin.

**Required config.** None beyond a correctly operated database. Superadmin accounts are instance-trusted; restrict them.

**Not guaranteed.**
- Authorization is enforced in services by convention, not by the data layer. There is no row-level security and no automated check that every Prisma query on a tenant table is scoped by org or project.
- Superadmins can read every org.

**Known gaps.**
- No differential test that every one of the 516 authenticated routes rejects a cross-tenant resource id (planned, Phase A of the isolation audit).
- No static rule that tenant-table queries are scoped (planned).
- Response shape/timing parity between "not found" and "forbidden" is by convention (`NotFoundException` in `requireProjectView`), not tested across routes. UNVERIFIED for routes that do their own lookups.

**Test.** Partial: `apps/server/test/org-isolation.test.ts` (org-scoped sessions and SSO enforcement against `AuthorizationService`), `apps/server/test/auth-coverage.test.ts` (route classification), `apps/server/test/rbac-coverage.test.ts` (RBAC rules of builder, tailscale and tenant roles against the rendered chart; needs `helm`), `apps/server/test/rbac.e2e.ts` (needs a database). Cross-tenant sweep over all routes: NONE.

---

## I2. Project to project inside an org (roles, guests, tokens, MCP grants)

**Invariant.** A principal holds exactly the rights of their project role. A plain org member or guest sees only projects they are a member of; a viewer cannot mutate; a project-scoped token or MCP grant cannot reach any other project or act with org-level power.

**Mechanism.**
- Role resolution: `AuthorizationService.resolveProjectAccess` (org owner/admin: all projects; project admin / member / viewer; unknown role names degrade to read-only).
- Project-scoped tokens: `tokenProjectIds` in the request context makes any other project resolve to `null` (404 shape); `getOrgAccess` strips `isAdmin` for project-scoped tokens; `requireOrgCanCreateProjects` and `requireOrgOwner` refuse them.
- Token and device route denylists in `superadmin.guard.ts`: `deniedToApiToken`, `deniedToProjectToken`, `deniedToOrgScopedSession`, `deniedToOrgSsoSession`; MCP gateway deny list `MCP_GATEWAY_DENY`.
- Token lineage: a minted token never outlives its parent, chain depth is capped (`apps/server/src/auth/api-tokens.service.ts`).
- CSRF: `crossSiteMutation` in `superadmin.guard.ts` (Origin against `PLATFORM_ORIGINS`/`FRONTEND_URL`, else `Sec-Fetch-Site`). A request with neither header is allowed, so non-browser clients are not CSRF-checked (they cannot ride a cookie).
- Pod exec requires `requireProjectEdit` and resolves the namespace to its project via `resolveNamespaceScope` (`apps/server/src/projects/namespace-scope.ts`, used in `apps/server/src/kubernetes/terminal.gateway.ts`).

**Required config.** None.

**Not guaranteed.** Project editors (`member`, `admin`) are trusted with their own project's resources, which includes exec into every pod of that project, including database pods, and reading the secrets bound to them. Org owners and admins see every project in the org.

**Known gaps.** Matrix test over role x token scope x MCP grant x route is not present (planned).

**Test.** `apps/server/test/api-token-lineage.test.ts`, `apps/server/test/mcp-gateway-scope.test.ts`, `apps/server/test/project-member-role.test.ts`, `apps/server/test/namespace-scope.test.ts`, `apps/server/test/security-hardening.test.ts` (denylists, SSE limiter, org-scoped devices), `apps/server/test/mcp-token-type.test.ts`, `apps/server/test/org-scoped-personal-credentials.test.ts`. Full role x route matrix: NONE.

---

## I3. Tenant network (workload to workload, workload to platform, workload to node and metadata)

**Invariant.** A pod in tenant namespace A can reach only: pods in A, DNS, the ingress controller namespaces, the public internet outside private/link-local ranges, other tenants' explicitly published (`-allow-public`) pods, and the backup proxy on TCP 9000. It cannot reach the kube-apiserver, node services, cloud metadata, or any unpublished service of another tenant or of the platform.

**Mechanism.**
- `tenantDenyPolicy` (`apps/server/src/kubernetes/security-policies.ts`) builds the `default-deny-all` NetworkPolicy (Ingress and Egress). Ingress: own namespace plus `tenantIngressNamespaces()` (default `network`, `orchard`; env `TENANT_INGRESS_NAMESPACES`). Egress: own namespace, ingress namespaces except the platform (`tenantEgressNamespaces`, env `TENANT_EGRESS_NAMESPACES`), `kube-dns` on 53, `0.0.0.0/0` except `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10`, all namespaces carrying `orchard.my/managed` or `orchard.dev/managed` (`TENANT_NAMESPACE_EGRESS_PEERS`), and the r2-proxy namespace on 9000.
- Applied by `K8sNamespaceService.createNamespace` -> `createNetworkPolicy` (`apps/server/src/kubernetes/k8s-namespace.service.ts`), replace-on-conflict.
- Re-applied on every boot of a lease-holding server 5 s after start: `onModuleInit` -> `reconcileTenantNetworkPolicies`.
- Continuously enforced by the engine guard: `GuardConsumer` (`apps/server/src/engine/consumers/guard.consumer.ts`) with `PrismaGuardDesired.expected` / `desired` (`apps/server/src/engine/guard/desired.ts`). Missing or edited `default-deny-all`, `allow-project-databases`, `allow-database-platform` and the Cilium policies are restored after a 10 s settle window, rate limited by `RestoreLimiter`, and audited as `security.policy.restored`.
- Publishing: `publicDeploymentPolicy` / `publicDatabasePolicy` open ingress from `0.0.0.0/0` and all namespaces for the named pods only; they exist only when the user turns on a public port or database.
- Cilium (when `cilium.enabled` or detected by `KubernetesService.isCiliumAvailable`): `ciliumIngressPolicy` (`allow-cilium-ingress`: from `host`, `remote-node`, `ingress` entities), `cnpgApiserverPolicy` (CNPG pods only may reach `kube-apiserver`), `cnpgOperatorPolicy`.
- Tenant pods set `automountServiceAccountToken: false` (`K8sWorkloadService`, `apps/server/src/kubernetes/k8s-workload.service.ts`; `JobsOrchestratorService`; `BuildkitPoolService`).
- Pod Security Admission labels on every tenant namespace: enforce `baseline`, audit and warn `restricted` (`createNamespace`).
- Builders: `builder-network-policy`, `buildkit-daemon-network-policy`, `buildkit-daemon-legacy-deny` in `infra/charts/orchard/templates/builders.yaml` and per-tenant daemon ingress `daemonTenantIngressPolicy` (`apps/server/src/docker/buildkit-daemon-policy.ts`).

**Required config.**
- A CNI that enforces `NetworkPolicy` (Cilium, Calico, Antrea, kube-router; not plain flannel). Orchard does not check this (see gaps).
- If the ingress controller is not in `network`/`orchard`, set `TENANT_INGRESS_NAMESPACES`.
- For nodes and the apiserver reachable on public IPs, the policy's RFC1918 exception list does not cover them; add Cilium entity denies (below).
- Hardened profile (planned as a chart profile): Cilium `CiliumClusterwideNetworkPolicy` denying egress from tenant namespaces to entities `host`, `remote-node`, `kube-apiserver`, and a DNS rule restricting names (see the information-disclosure section).

**Not guaranteed.**
- With no enforcing CNI, `default-deny-all` is inert.
- A plain NetworkPolicy cannot deny traffic to node public IPs, host-network services, or an apiserver reachable on a public IP, because those fall in `0.0.0.0/0` minus the private ranges. The repo contains no Cilium host/apiserver entity deny for tenants (grep of `infra/`, `install/`, `apps/server/src` finds only allow-entities). Operators reported it blocked on one cluster (hq) by cluster-level policy, which is outside this repo.
- IPv6 is not addressed by the egress ipBlock (only `0.0.0.0/0`), so IPv6 egress is denied by default-deny rather than filtered.
- Tenants share the published surface: a tenant can reach another tenant's `-allow-public` pods directly over the pod network.

**Known gaps (verified in code).**
1. Fail-open at creation. `createNamespace` catches a `createNetworkPolicy` failure and only `console.error`s it (`k8s-namespace.service.ts` lines 281 to 288); the project is created and workloads can deploy into a namespace with no `default-deny-all` until the guard's informer sweep or the next server boot restores it. The window length is not measured (UNVERIFIED). Ordering is otherwise correct: the policy is created immediately after the namespace and before the caller (`ProjectsService`, `EnvironmentsService`) creates any workload.
2. Existing-namespace path: the `409` branch of `createNamespace` (line 309) does not re-apply the policy; it relies on the guard.
3. Platform namespaces have no ingress policy in the chart. `grep "kind: NetworkPolicy"` in `infra/charts/orchard/templates` matches only builders, object-storage, r2-proxy (ingress from anywhere on 9000), sandboxes, fc-builder, redis, trivy. The control-plane Postgres, server, VictoriaLogs, VictoriaMetrics have none; their protection is the tenant egress deny. The manual `infra/k8s/orchard-metrics/30-network-policies.yaml` lets VictoriaMetrics accept queries from `namespaceSelector: {}`.
4. `allow-cilium-ingress` admits `host` and `remote-node` entities to every tenant pod.
5. No check that the CNI enforces policy (`KubernetesService.probeCilium` only detects Cilium CRDs).
6. `r2-proxy` NetworkPolicy comment says tenant namespaces are not labeled; they are (`orchard.my/managed`). The rule is still "from anywhere" by design, with per-key SigV4 prefix policy as the boundary.

**Test.** `apps/server/test/tenant-policy.test.ts` (ingress namespace config), `apps/server/test/security-hardening.test.ts` (imports `tenantDenyPolicy`), `apps/server/test/database-platform-policy.test.ts`, `apps/server/test/engine-guard.test.ts` (restoration of deleted policies), `apps/server/test/buildkit-daemon-policy.test.ts`, `apps/server/test/compose-network.test.ts`. Live enforcement (pod A cannot reach pod B, apiserver, node): NONE (planned CI job with kind/k3d + Cilium).

---

## I4. Tenant compute (kernel)

**Invariant.** A process in tenant A's container cannot affect the host kernel or any other tenant's process, because the tenant pod runs under a sandbox runtime (gVisor, Kata or a microVM) when the instance is configured for untrusted code.

**Mechanism.** `tenantRuntimeClassName()` (`apps/server/src/kubernetes/trusted-images.ts`) reads `TENANT_RUNTIME_CLASS` and is applied to app Deployments (`K8sWorkloadService`, line 1030), rollouts (`buildGreenDeployment` and patches in `rollout-strategy.ts`, `k8s-workload.service.ts` line 2696) and job runs (`JobsOrchestratorService`, line 345). Containers use `hardenedSecurityContext()`: `allowPrivilegeEscalation: false`, drop `ALL` then add `SETUID, SETGID, CHOWN, FOWNER, DAC_OVERRIDE, SYS_CHROOT`, `seccompProfile: RuntimeDefault`. PSA `baseline` is enforced on the namespace. Builds: `builderSandbox` (Kata) sets `BUILDER_RUNTIME_CLASS`; Depot-mode builds use `depotRuntimeClassName` (gVisor) (`image-builder.service.ts`, `buildkit-pool.service.ts`).

**Required config.** `tenantSandbox.enabled=true` with `runtimeClassName: gvisor` and the runtime installed on every node (chart `runtimeclass-gvisor.yaml`, sets `TENANT_RUNTIME_CLASS` in `_helpers.tpl`); `builderSandbox.enabled=true` with Kata and KVM for BuildKit (which needs `privileged`).

**Not guaranteed.**
- Default: both off. Tenant pods use `runc` and share the host kernel; a kernel or runtime escape compromises the node and every tenant on it. The setup checklist warns when two or more users exist (`setup.service.ts`, id `tenant-isolation`).
- Without `builderSandbox`, build pods are `privileged: true` (`image-builder.service.ts`, buildkit container `securityContext`). A hostile Dockerfile build then runs with host-level privilege.
- Managed database pods (CNPG) get no `runtimeClassName` anywhere in the code (grep of `runtimeClass`: only workloads, jobs, builders). They run trusted Postgres images, but tenants run SQL in them.
- gVisor is not a hardware boundary; Kata/microVM is closer to what Firecracker gives.
- `restricted` PSA is not enforced (root-in-container allowed); `readOnlyRootFilesystem` is not set.

**Known gaps.** `runtimeClassName` is a server-side default: an editor cannot choose it, but if `TENANT_RUNTIME_CLASS` is unset the pod silently runs on runc; no admission policy forces a runtimeClass on tenant namespaces (the only ValidatingAdmissionPolicy is the registry policy, `registry-image-policy.ts`). Planned: an admission policy requiring `runtimeClassName`.

**Test.** `apps/server/test/tenant-sandbox-uniform.test.ts` (runtime class and hardened context on every code path that builds a tenant pod), `apps/server/test/build-sandbox.test.ts`, `apps/server/test/build-config.test.ts`. No test that a rendered chart with `tenantSandbox.enabled` has the RuntimeClass: partial in `apps/server/test/chart-render.test.ts` (UNVERIFIED which assertions).

---

## I5. Builds (source, secrets, caches, registry credentials)

**Invariant.** A build for project A cannot read project B's source, build secrets, cache, or registry images, and cannot push to another project's repository.

**Mechanism.**
- One BuildKit daemon per tenant key (the project namespace, `cacheTenantKey: data.namespace` in `deployments.service.ts` line 8332): `BuildkitPoolService.getOrCreateDaemon`, daemon ingress only from build pods with the same `orchard.my/tenant-key` label (`daemonTenantIngressPolicy`).
- Local cache is a per-tenant subPath of the cache PVC (`cacheSubPath` in `image-builder.service.ts`).
- Registry login: with `BUILDER_SIDECAR_PUSH` not `false`, BuildKit runs with no registry login and a separate pusher container holds it (`builderSandbox.sidecarPush`, default true).
- Per-project image ownership on the registry: ValidatingAdmissionPolicy `orchard-tenant-images` (`registryImagePolicy`, `apps/server/src/kubernetes/registry-image-policy.ts`, installed by `RegistryImagePolicyService`) rejects a pod in a labeled namespace that names another project's repository on the platform registry. Mode from `REGISTRY_IMAGE_POLICY` (`enforce|warn|off`, default `warn`).
- Build egress is allow-listed (`builder-network-policy`, `orchard.builderEgressRules`), no apiserver, no IMDS.
- Build secrets: `build-args.ts`, `build-log-redaction.ts`, `buildSafeEnv`.

**Required config.** `REGISTRY_IMAGE_POLICY=enforce` (the installer sets it; the code default is `warn`); `builderSandbox` with Kata; `builders.registryEgress` correct; a dedicated cache bucket/key.

**Not guaranteed / known gaps (verified).**
1. Registry credential is shared. `harbor-registry-creds` (`builders.yaml`) holds one username/password for the platform project; the server's own path defaults to `HARBOR_USERNAME || 'admin'` (`image-builder.service.ts` `harborAuths`). All tenants' images live in one Harbor project, so a leaked builder login reaches every tenant's repository. Per-org or per-project robot accounts are planned.
2. S3 build cache uses one bucket-wide key (`BUILDKIT_S3_ACCESS_KEY_ID` or the object-storage key; `buildkit-s3-cache-creds` in `builders.yaml`). The prefix is chosen by Orchard (`buildCacheArgs`), but nothing restricts the credential to it, and the credential is handed to the build pod as `ORCHARD_S3_CACHE_*`. Routing the cache through r2-proxy prefix keys is planned. Whether the Job-path cache flags are scoped per repository (`buildCacheArgs()` is called without a key at `generateBuildScriptWithCacheFallback`) is UNVERIFIED.
3. Without Kata, builds are privileged on the host kernel (I4).
4. Super builds (Depot) with `BUILDER_SIDECAR_PUSH=false` place the shared registry login in the Depot session (documented in `security.mdx`).

**Test.** `apps/server/test/buildkit-daemon-policy.test.ts`, `apps/server/test/registry-image-policy.test.ts`, `apps/server/test/build-secrets.test.ts`, `apps/server/test/build-arg-injection.test.ts`, `apps/server/test/image-builder-cache.test.ts`, `apps/server/test/builder-override-access.test.ts`, `apps/server/test/build-sandbox.test.ts`. Cross-tenant cache/registry attack: NONE.

---

## I6. Secrets (env, DB credentials, registry credentials, tokens)

**Invariant.** A secret value is readable only by principals with edit rights on its project (and by the workload it is bound to), is never returned by read APIs once written, and is not readable by other tenants at rest or in transit.

**Mechanism.**
- At-rest encryption of secret env vars, shared vars, job step secrets and database passwords: `SecretCryptoService` (`apps/server/src/crypto/secret-crypto.service.ts`), AES-256-GCM, `enc:v1:` prefix, key from `SECRETS_ENCRYPTION_KEY` (falls back to `SSO_ENCRYPTION_KEY`). Per-user sealing exists (`encryptForUser`, `enc:u1:`). Boot backfill encrypts old rows (`SecretBackfillService`).
- Write-only secrets: `env-secret-write-only`, `redactDatabaseForViewer` / `stripR2ProxyCreds` / `sealDatabaseCredentials` (`apps/server/src/projects/projects.utils.ts`), log redaction (`build-log-redaction.ts`, `logs`).
- In-cluster: values reach pods as Kubernetes Secrets. The server holds Secret read/write per tenant namespace only through a namespaced RoleBinding to ClusterRole `<release>-tenant-secrets` (`bootstrapTenantSecretsRbac`, `tenant-rbac.ts`), not cluster-wide.
- Tenant pods have no service account token mounted.

**Required config.** `SECRETS_ENCRYPTION_KEY` set. Kubernetes etcd encryption at rest for the Secrets (cluster feature).

**Not guaranteed / known gaps (verified).**
1. With no key configured the service logs an error and stores secrets in plaintext (`encryptIfSecret` returns the value as is). `encrypt` itself throws. The chart does not generate or require the key; the only mention in `values.yaml` is for Vercel machines.
2. One instance-wide key for all orgs; no per-org keys, no KMS.
3. Anyone with project edit can exec into their pods and read the environment of their own app. Intended.
4. The wildcard database TLS private key is copied into every tenant namespace with a public database by default (`publicTls.db.mode: wildcard`, `K8sCnpgService.syncPublicTlsSecret`). A project editor can exec into the database pod and read it, then impersonate every other database under the wildcard. `perDatabase` mode removes this but consumes Let's Encrypt rate limit (per registered domain, 50 certificates per week) and needs a DNS-01 issuer. A scalable design (SNI proxy or higher-limit CA) is planned.
5. CNPG clusters are created with `enableSuperuserAccess: true` (`k8s-cnpg.service.ts` line 1795, `cnpg-recovery.ts` line 391); who can read the superuser secret via the API was not traced (UNVERIFIED). Project editors can exec into the database pod regardless.
6. Domain-proof token uses `JWT_SECRET` as HMAC key (`domainProofToken`).

**Test.** `apps/server/test/secret-crypto-seal.test.ts`, `apps/server/test/env-secret-write-only.test.ts`, `apps/server/test/secret-redaction.test.ts`, `apps/server/test/log-redaction.test.ts`, `apps/server/test/tenant-rbac.test.ts`, `apps/server/test/public-db-tls.test.ts`, `apps/server/test/database-public-connection.test.ts`. Fail-closed when the key is missing: NONE (current behavior is fail-open for env vars).

---

## I7. Storage and backups (uploads, S3/R2, CNPG, restore drills)

**Invariant.** A tenant's backup credentials, uploads and restore operations touch only that tenant's bucket prefix, and the platform's real object-store credentials never reach a tenant namespace.

**Mechanism.**
- `apps/r2-proxy/main.go`: S3 SigV4 re-signing gateway. Per-cluster fake keys are looked up in Postgres (`bindingStore.lookup`, `lookupScoped`, `lookupRestore`); `authorizeOperation` allows only the operations barman needs, within the key's `bucket + prefix` (`validPrefix`, `withSlash`), refuses copy sources, dot segments, ambiguous targets (`validateTarget`, `strictQuery`, `checkHeaders`), and checks multi-delete per key (`deleteRequestKeys`). `ALLOWED_BUCKETS` / `DEFAULT_BACKUP_BUCKET` bound which buckets the platform credentials serve; with neither set and an endpoint set the proxy refuses to start. The proxy connects to Postgres as read-only `orchard_r2_proxy` with column-level grants (`prisma.service.ts`, checked by `r2-proxy-grants.test.ts`).
- Real credentials live only in `r2-proxy-upstream` in the `orchard-r2-proxy` namespace (`r2-proxy.yaml`).
- Uploads: `assertUploadUrlOwned` (`apps/server/src/organizations/upload-namespace.ts`), public `GET /uploads/*path` serves only image types with `nosniff`, `CSP sandbox` (`UploadsController`).
- Restore drills run in a separate namespace (`database-operations.service.ts`, `DRILL_NAMESPACE`).

**Required config.** `r2Proxy.allowedBuckets` (or `defaultBucket`) listing exactly the buckets; separate bucket (or key) for build cache and uploads; `r2Proxy.networkPolicy.enabled`.

**Not guaranteed / gaps.** r2-proxy accepts connections from any namespace (see I3 gap 6). If a database uses an org-supplied bucket (`backupR2*` org fields), that credential is the org's own. Differential fuzz of "authorized bytes == forwarded bytes" is partly covered by Go tests (`TestEveryAcceptedRequestIsForwardedAsAuthorizedAndSignedAsSent`).

**Test.** `apps/r2-proxy/main_test.go` (41 tests, e.g. `TestObjectsOutsidePrefixAreRefused`, `TestMultiDeleteIsCheckedPerKey`, `TestEmptyAllowlistServesNoBucketWithPlatformCredentials`), `apps/server/test/r2-proxy-grants.test.ts`, `apps/server/test/upload-namespace.test.ts`, `apps/server/test/object-storage.test.ts`, `apps/server/test/database-recovery.test.ts`. Backup/restore across tenants end to end: NONE.

---

## I8. Observability (logs, metrics, events, traces, status pages)

**Invariant.** A user sees logs, metrics, events and status of only the projects they can view; a tenant workload cannot query the platform's metrics or log stores.

**Mechanism.** Log queries are scoped by namespace through `scope()` in `apps/server/src/logs/logsql.ts` (`requireValue('namespace', ...)`), after the controller's project authorization. Metrics via `apps/server/src/metrics/victoria-metrics.service.ts` and `pod-selector.ts`. Status pages render only `isPublic` pages and return the same absence for missing and private (`StatusPagesService.render` -> `build`, `resolveHost`). Tenant pods cannot reach VictoriaMetrics/VictoriaLogs because of the I3 egress deny.

**Required config.** I3 holds. Do not expose VictoriaMetrics/Logs outside the cluster.

**Known gaps.** VictoriaMetrics and VictoriaLogs have no authentication and no ingress NetworkPolicy in the chart (I3 gap 3); a tenant that loses default-deny (fail-open window, no enforcing CNI) can query every tenant's metrics and logs. Per-query namespace scoping was read at `logsql.ts`; every metrics query path was not audited (UNVERIFIED).

**Test.** `apps/server/test/logsql.test.ts`, `apps/server/test/logs-store.test.ts`, `apps/server/test/status-page.test.ts`, `apps/server/test/pod-selector.test.ts`, `apps/server/test/ingress-metrics.test.ts`. Cross-tenant query attempt: NONE.

---

## I9. Identity (SSO, SCIM, OAuth, passkeys cannot reach outside their org)

**Invariant.** An IdP, SCIM token or SSO session belonging to org A can create, sign in or modify only identities and memberships within org A, and cannot be used to take over an account or org of another tenant.

**Mechanism.**
- Org-scoped sessions carry `sessionOrgId`; the whole org tree and project tree refuse other orgs (`getOrgAccess`, `resolveProjectAccess`, `listVisibleProjectIds`); account-widening routes are denied (`deniedToOrgScopedSession`, `ORG_SCOPED_ALLOW`).
- Email-domain routing only uses domains the org verified (`OrgDomainsService.ownerOf`, `isVerifiedFor`, `apps/server/src/sso/org-domains.service.ts`); another org cannot verify an already verified domain.
- SSO enforcement: `AuthorizationService.assertSsoNotEnforced`, `blockedByOrgSso`.
- Unverified adoption: `discardUnverifiedCredentials` (`apps/server/src/auth/unverified-adoption.ts`).
- SAML guard `apps/server/src/sso/saml-guard.ts`, OIDC state store; SCIM bearer auth `scim-auth.guard.ts` (routes are `@Public()` at the router level and authenticated by the SCIM token).

**Required config.** Verify the org's domains before enabling enforcement; do not enable instance-level SSO bypass.

**Known gaps.** The identity-linking fixes live on separate branches (`fix/identity-linking`); this spec assumes they are merged. Property tests for SAML/SCIM/OAuth lineage are planned (Phase E).

**Test.** `apps/server/test/sso-enforcement.test.ts`, `apps/server/test/saml-hardening.test.ts`, `apps/server/test/saml-trust-config.test.ts`, `apps/server/test/scim.test.ts`, `apps/server/test/unverified-adoption.test.ts`, `apps/server/test/org-isolation.test.ts`, `apps/server/test/passkey.test.ts`, `apps/server/test/mcp-oauth-hardening.test.ts`.

---

## I10. Ingress and browser origin (host claims, certs, cookie scope, tenant apps vs dashboard)

**Invariant.** Only the project that legitimately holds a hostname receives its traffic; a tenant app cannot read or set the dashboard's credentials, and cannot obtain a certificate for a host it does not control.

**Mechanism.**
- Host claims: `ProjectAccessService.assertHostnameUnclaimed` / `assertHostnameAvailable` (`apps/server/src/projects/project-access.service.ts`) with a global advisory lock (`beginHostClaim`, `lockHostnameClaims`), reserved hosts and labels (`isReservedHost`, `isReservedSubdomainLabel`, `apps/server/src/instance-network/reserved-hosts.ts`, env `RESERVED_HOSTS`, `RESERVED_HOST_SUFFIXES`), generated labels carry a random 6 hex suffix.
- Custom-domain proof of ownership: TXT `_orchard-challenge.<host>` (`domainProofStatus`, `domain-proof.ts`), or a verified org domain.
- Protected apps: `ProtectionService` (`apps/server/src/auth/protection.service.ts`), per-ingress cookie name `protectionCookieName`, cookie is `HttpOnly`, `SameSite=Lax`, path `/`, no `Domain` attribute (host-only).
- Dashboard session cookie `session_token`: `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Domain` only when `COOKIE_DOMAIN` is set (`apps/server/src/auth/cookies.ts`). CORS: platform origins with credentials, tenant-facing GET routes open with credentials off (`apps/server/src/main.ts`).
- Client IP: `getClientIp` and `parseTrustProxy` (`apps/server/src/auth/client-ip.ts`), `TRUST_PROXY` (chart `clientIp.trustProxy`, default `"1"`), Cloudflare ranges trusted unless `TRUST_CLOUDFLARE=false`.

**Required config.**
- Serve tenant apps from a registrable domain different from the dashboard, preferably one on the Public Suffix List (see `docs/vercel-comparison.md`). Do not set `COOKIE_DOMAIN` to a parent of the app domain.
- `CUSTOM_DOMAIN_VERIFICATION=true` (or the admin switch).
- `TRUST_PROXY`/`clientIp.*` matching the real topology; restrict origin traffic to the CDN.

**Not guaranteed / known gaps (verified).**
1. Custom-domain verification defaults to off (`resolveBool(..., fallback=false)`; docs: "the switch starts off"): first claim wins, no proof of DNS control. Traffic still needs DNS to point at the cluster, but a squatter can pre-claim a host.
2. The session cookie has no `__Host-` prefix. If `COOKIE_DOMAIN` is a parent of tenant app hosts, every tenant app receives the dashboard session cookie, and can set sibling cookies.
3. Neither the chart defaults nor the code reference the Public Suffix List. The generated app domain is operator-chosen (`APP_DOMAIN`, `PLATFORM_WILDCARD_DOMAINS`); an unlisted domain gives tenant apps shared cookie scope with each other and with any parent-domain cookie (cookie tossing). The only PSL mention in the repo concerns `sslip.io` rate limits (`start/install.md`).
4. Cloudflare origin is not locked by the chart: `cf-connecting-ip` is read only if the connecting hop is in `headerFrom`/Cloudflare ranges, but nothing stops direct-to-origin traffic bypassing the CDN/WAF. Locking the origin (firewall or Tunnel) is the operator's job. The `hq` origin lock status is UNVERIFIED.
5. Certificate Transparency: every public hostname appears in CT logs (information disclosure section).

**Test.** `apps/server/test/host-claim.test.ts`, `apps/server/test/hostname-reservation.test.ts`, `apps/server/test/reserved-hosts.test.ts`, `apps/server/test/reserved-generated-zones.test.ts`, `apps/server/test/client-ip.test.ts`, `apps/server/test/protection-*.test.ts` (auth, bypass-paths, session-binding, proxy-headers, redirect), `apps/server/test/ingress-limits.test.ts`, `apps/server/test/xss-and-assets.test.ts`. Cookie scope vs app domain: NONE.

---

## I11. Resource fairness (quotas, noisy neighbour, pre-auth DoS)

**Invariant.** One tenant cannot exhaust CPU, memory, pods, volumes or request budget in a way that degrades another tenant beyond its configured share.

**Mechanism.** `K8sNamespaceService.applyNamespaceQuota` writes `ResourceQuota orchard-org-quota` and `LimitRange orchard-defaults` using `tenantQuotaHard` / `tenantQuotaFloor` (`tenant-quota.ts`): always `pods` (default 200), `services` (100), `persistentvolumeclaims` (50), `requests.storage` (500 GiB), and CPU/memory only when the org has caps. Pushed by `QuotasService` (`apps/server/src/quotas/quotas.service.ts`). Per-IP and per-account throttles: `ApiThrottlerGuard`, `RateLimitService`, `RedisThrottleService`, `preauth` limits, body limits, SSE limiter, ingress limits.

**Required config.** Set org CPU/memory caps (without them no CPU or memory quota exists in the namespace); resource limits on (`resource-limits.md`); node pools for noisy tenants; Redis for cross-replica throttling.

**Known gaps.** Default quota does not cap CPU or memory. Quotas are per namespace; per-org totals are API-layer aggregation (comment in `quotas.service.ts`). Whether quota is applied at namespace creation or only on first quota sync was not traced (UNVERIFIED). No node-level isolation by default.

**Test.** `apps/server/test/tenant-quota.test.ts`, `apps/server/test/quota-zero.test.ts`, `apps/server/test/owner-allowance.test.ts`, `apps/server/test/resource-limits.test.ts`, `apps/server/test/api-throttler.test.ts`, `apps/server/test/preauth-rate-limit.test.ts`, `apps/server/test/body-limits.test.ts`, `apps/server/test/sse-stream-limiter.test.ts`.

---

## I12. Lifecycle (delete, transfer, restore, revoke)

**Invariant.** After a project, environment, member, token or domain is deleted, transferred or revoked, nothing of it remains reachable by the previous owner or by a successor tenant (names, data, credentials, policies).

**Mechanism.** `NamespaceTeardownService.teardown` (`apps/server/src/projects/namespace-teardown.service.ts`: deployments, databases, jobs, builds, registry repositories, build contexts, backup prefixes); `RetiredNamespace` table prevents namespace reuse (`freshNamespace`); org transfer `project-org-transfer.service.ts` plus `tagNamespaceMoved` (a namespace keeps its original name, labeled with the new org); credentials discarded on adoption (`discardUnverifiedCredentials`); membership cache invalidation (`MembershipCacheService`); session revocation (`SessionsService`); `OrgEventStream` reauth.

**Required config.** None.

**Known gaps.** The namespace name keeps the former org/project slug after a transfer (information disclosure). Namespace deletion removes the namespace; PV reclaim policy and storage-backend scrubbing depend on the StorageClass (UNVERIFIED). `fix/access-lifecycle` is a separate branch.

**Test.** `apps/server/test/namespace-teardown-keep.test.ts`, `apps/server/test/delete-deployment-builds.test.ts`, `apps/server/test/org-event-stream-reauth.test.ts`, `apps/server/test/session-jwt.test.ts`, `apps/server/test/backup-orphans.test.ts`. Transfer-then-access test: NONE.

---

## Cluster control plane: the server service account

`infra/charts/orchard/templates/server-rbac.yaml` grants `orchard-server` a ClusterRole (`<release>-server`) bound cluster-wide by a ClusterRoleBinding. It is not literally `cluster-admin`, and it deliberately excludes cluster-wide secrets and configmaps, but it is effectively cluster-admin:

- `pods` create/patch/delete and `pods/exec`, `pods/attach`, `pods/portforward` in every namespace, including `kube-system`: a pod can be created mounting `hostPath` unless the target namespace enforces PSA (only tenant namespaces are labeled).
- `roles` and `rolebindings` create/update/delete in every namespace, plus `bind` on ClusterRole `<release>-tenant-secrets`: the server can grant itself read of every Secret in any namespace, including `kube-system` and the Cilium/cert-manager namespaces.
- `namespaces` delete and patch, `networkpolicies` delete, `validatingadmissionpolicies` / `validatingadmissionpolicybindings` delete: the server can remove every isolation control.
- `serviceaccounts` create, `nodes` patch/update, `nodes/proxy` get (kubelet API).
- The server also needs the admin kubeconfig path when `KUBECONFIG_BASE64` / `KUBECONFIG_PATH` is used (`kubeconfig.ts`).

Consequence: a remote code execution or SSRF in the server is a cluster takeover. The tenant boundary rests on the server being correct. The least-privilege redesign (namespaced Roles per tenant namespace, admission policies protecting the isolation objects, impersonation) is planned (Phase B).

Test: `apps/server/test/rbac-coverage.test.ts` pins the builder, tailscale and tenant roles against the rendered chart; there is no test pinning the server ClusterRole itself.

---

## What a tenant can learn about other tenants

For each channel: what leaks, to whom, how to reduce, and whether it is acceptable.

| Channel | What leaks | To whom | Reduce | Acceptable? |
| --- | --- | --- | --- | --- |
| Cluster DNS service enumeration | Service names and namespaces of every tenant (and platform) via `*.svc.cluster.local` queries, including CoreDNS wildcard SRV `any.any.svc.cluster.local`. Tenant egress policy allows DNS to `kube-dns` for all names (`tenantDenyPolicy`, no name filter). Not tested live in this audit (UNVERIFIED). | Any tenant pod | Cilium L7 DNS policy: `egress.toEndpoints` kube-dns with `rules.dns.matchPattern` limited to `*.<own-namespace>.svc.cluster.local` and external names; CoreDNS config to drop `kubernetes` wildcard/SRV answers for foreign namespaces (e.g. the CoreDNS `kubernetes` plugin `namespaces`/`fallthrough` or a `template` block returning NXDOMAIN). Planned. | Not acceptable in the hardened profile; acceptable on a single-trust instance. |
| Namespace names | `{org-slug}-{project-slug}-{hex}` reveals org and project names to anything that can list namespaces (kubectl users, any pod with a token, the metrics/log labels). Tenant pods have no token and no apiserver route. After an org transfer the old org slug persists (`tagNamespaceMoved`). | Cluster admins, operators, graft/sandbox pods with RBAC | Keep tenants away from the apiserver; consider opaque namespace names (planned design question: opaque ids vs readable names). | Acceptable for the operator; not for tenants, who cannot list them when I3 holds. |
| Kubernetes API reachability | apiserver ClusterIP and its backend IPs are not in the allow list, but a public apiserver address is outside the RFC1918 exceptions. | Tenant pod | Cilium entity deny `kube-apiserver`, `host`, `remote-node`; no ServiceAccount token (already `automountServiceAccountToken: false`). | Only acceptable with the entity deny or a private apiserver endpoint. |
| Metrics | VictoriaMetrics has no auth and no ingress policy in the chart; kube-state-metrics and node-exporter expose all namespaces' pod/deployment names and node data. | Any pod that can route to `orchard-metrics` | Keep the I3 egress deny; add ingress NetworkPolicy on platform namespaces; authentication proxy. | Acceptable only while I3 holds. |
| Logs | VictoriaLogs unauthenticated, same exposure. | Same | Same | Same |
| Status pages | Org name, component names and status for pages with `isPublic`. Private and missing pages are indistinguishable (`StatusPagesService.build`). | Anyone | Only publish deliberately. | Yes, opt-in. |
| Public hostnames in Certificate Transparency | Every host with a publicly trusted certificate (per-host ACME) is logged. A wildcard certificate (`wildcard-certificates.md`) hides individual labels. | Anyone | Wildcard certificate for generated app hosts; random label suffixes already exist (`GENERATED_APP_LABEL`). | Yes for public sites; use wildcard for private projects. |
| `GET /sso/org/:slug` | For an org with SSO live: org uuid, name, slug, avatar, login branding, enabled provider names and start URLs (`SsoService.getOrgLoginContext`). A slug without live SSO is the same 404 as a missing slug, so it does not enumerate orgs generally. | Anyone | Rate limit (pre-auth limiter), consider omitting the uuid. | Acceptable; it is the login page payload. |
| `GET /sso/subdomain/:subdomain` | Maps a legacy vanity subdomain to `{slug, name}`, same 404 rule. | Anyone | As above | Acceptable. |
| `POST /sso/discover` | Always 200; returns an org only if the email domain is verified by an org with live SSO. | Anyone | As above | Acceptable (verified domains only). |
| `GET /sso/providers`, `GET /auth/methods`, `GET /auth/config`, `GET /setup/status`, `GET /health` | Instance-level login methods and setup state. | Anyone | Fine on SaaS. | Acceptable. |
| `GET /invitations/:token` | Org name, slug, avatar, role, expiry for a valid unexpired token; email only if invite delivery is not `email`. Lookup by token hash; same 404 for unknown and expired. | Holder of the link | Token entropy and expiry. | Acceptable. |
| `GET /status/:slug`, `GET /status/resolve` | See status pages. | Anyone | | Acceptable. |
| `GET /uploads/*path` | Public, image types only; guessing paths needs the random key. | Anyone with the URL | | Acceptable. |
| `GET /auth/protect/info`, `/check` | Protection mode of a tenant host (login, password or Orchard login). | Anyone | | Acceptable. |
| Scim routes | Router-public, authenticated by the SCIM bearer token (`scim-auth.guard.ts`); 401 otherwise. | Token holder | | Acceptable. |
| IDOR error differences | Services return `NotFoundException` for no-access (org, project); some routes that do their own lookup may differ. Timing differences between "exists but forbidden" and "missing" were not measured. | Authenticated users | Cross-tenant differential harness (planned Phase A). | UNVERIFIED. |
| Pod-network reachability of published services | Another tenant's `-allow-public` pods answer on their ports directly (egress rule 5). | Tenant pods | By design; same surface as the internet. | Acceptable. |
| Shared node effects | Under runc, node-level timing and resource contention; `/proc` and kernel side channels. | Co-located tenants | gVisor/Kata, dedicated node pools. | Not guaranteed. |

---

## Summary table

| Invariant | Mechanism | Required config | Test | Status |
| --- | --- | --- | --- | --- |
| I1 org to org control plane | `AuthorizationService` org/project resolvers, `SuperAdminGuard`, auth coverage snapshot | none | `org-isolation.test.ts`, `auth-coverage.test.ts`; full cross-tenant route sweep NONE | Enforced by convention; no data-layer guard; sweep planned |
| I2 project to project | role resolution, `tokenProjectIds`, token/MCP denylists | none | `api-token-lineage`, `mcp-gateway-scope`, `project-member-role`, `namespace-scope` | Enforced; matrix test NONE |
| I3 tenant network | `tenantDenyPolicy`, engine guard, Cilium policies, PSA baseline, no SA token | enforcing CNI; ingress namespaces; Cilium host/apiserver entity denies; DNS rules | `tenant-policy`, `engine-guard`, `database-platform-policy`; live enforcement NONE | Partial: creation fail-open, no node/apiserver deny in repo, platform namespaces lack ingress policy |
| I4 tenant compute | `TENANT_RUNTIME_CLASS`, `hardenedSecurityContext`, Kata builders | gVisor/Kata installed and enabled | `tenant-sandbox-uniform`, `build-sandbox` | Off by default; CNPG pods unsandboxed |
| I5 builds | per-tenant BuildKit daemon, sidecar push, image ownership policy | Kata; `REGISTRY_IMAGE_POLICY=enforce`; dedicated cache key | `buildkit-daemon-policy`, `registry-image-policy`, `build-secrets` | Partial: shared registry login, bucket-wide S3 cache key |
| I6 secrets | AES-256-GCM at rest, write-only, namespaced secret RBAC | `SECRETS_ENCRYPTION_KEY`; etcd encryption; `publicTls.db.mode: perDatabase` | `secret-crypto-seal`, `env-secret-write-only`, `public-db-tls` | Partial: plaintext if key unset; wildcard DB key in tenant namespaces by default |
| I7 storage and backups | r2-proxy prefix policy, read-only DB role, upload namespaces | `r2Proxy.allowedBuckets`; separate buckets | `apps/r2-proxy/main_test.go`, `r2-proxy-grants`, `upload-namespace` | Enforced; e2e cross-tenant NONE |
| I8 observability | namespace-scoped queries, public-only status pages | I3; no external exposure of VM/VL | `logsql`, `status-page`, `pod-selector` | Depends on I3; stores unauthenticated |
| I9 identity | `sessionOrgId`, verified domains, SSO enforcement, SCIM token | verify domains; merged identity fixes | `sso-enforcement`, `saml-hardening`, `scim`, `org-isolation` | Enforced; property tests planned |
| I10 ingress and origin | host claims, domain proof, reserved hosts, host-only protection cookie | PSL-listed app domain; no `COOKIE_DOMAIN` parent; `CUSTOM_DOMAIN_VERIFICATION`; `TRUST_PROXY`; origin lock | `host-claim`, `reserved-hosts`, `client-ip`, `protection-*` | Partial: verification off by default, no `__Host-`, origin unlocked, PSL undocumented |
| I11 resource fairness | ResourceQuota/LimitRange, throttlers | org CPU/memory caps | `tenant-quota`, `api-throttler`, `preauth-rate-limit` | Partial: no CPU/memory quota by default |
| I12 lifecycle | teardown, retired namespaces, session/credential revocation | none | `namespace-teardown-keep`, `delete-deployment-builds` | Partial: transfer keeps old slug in namespace; transfer test NONE |
| Server SA scope | ClusterRole `<release>-server` | none today | `rbac-coverage` (not the server role) | Gap: effectively cluster-admin |
