package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The parity gate: every non-superadmin route in the server's auth-coverage
// snapshot must either be driven by a CLI command (routeCoverage) or carry an
// explicit exclusion with a reason (routeExclusions). When the server grows a
// route, this test fails until the CLI grows a command or an exclusion; when
// the server removes or renames a route, the inverse checks flag the stale
// map entry.
const authSnapshotPath = "../../server/test/auth-coverage.snapshot.json"

// routeCoverage maps snapshot routes ("METHOD /path", verbatim) to the CLI
// command that drives them.
var routeCoverage = map[string]string{
	// auth: tokens + sessions + identity
	"GET /auth/me":                   "auth status",
	"GET /auth/tokens":               "auth token list",
	"POST /auth/tokens":              "auth token create",
	"DELETE /auth/tokens/:id":        "auth token revoke",
	"GET /auth/sessions":             "auth session list",
	"DELETE /auth/sessions/:id":      "auth session revoke",
	"POST /auth/sessions/revoke-all": "auth session revoke-all",

	// user profile
	"PATCH /auth/me":         "user profile update",
	"POST /auth/me/avatar":   "user avatar set",
	"DELETE /auth/me/avatar": "user avatar delete",

	// org
	"GET /organizations/user":                "org list",
	"GET /organizations/:id":                 "org get",
	"GET /organizations/slug/:slug":          "org get (slug resolution)",
	"PATCH /organizations/:id":               "org update",
	"PATCH /organizations/:id/subdomain":     "org update --subdomain",
	"POST /organizations/:id/avatar":         "org avatar set",
	"DELETE /organizations/:id/avatar":       "org avatar delete",
	"GET /organizations/:id/backup-settings": "org backup-settings get",

	// org members + invitations
	"GET /organizations/:id/members":                           "member list",
	"POST /organizations/:id/members":                          "member invite",
	"DELETE /organizations/:id/members/:memberId":              "member remove",
	"PATCH /organizations/:id/members/:memberId":               "member set-role",
	"GET /organizations/:id/invitations":                       "member invites list",
	"DELETE /organizations/:id/invitations/:invitationId":      "member invites cancel",
	"POST /organizations/:id/invitations/:invitationId/resend": "member invites resend",

	// my invitations
	"GET /invitations/pending":            "invitation list",
	"POST /invitations/by-id/:id/accept":  "invitation accept",
	"POST /invitations/by-id/:id/decline": "invitation decline",

	// projects
	"GET /projects":                                  "project list",
	"POST /projects/import":                          "import",
	"GET /projects/:id":                              "project get",
	"GET /projects/slug/:slug":                       "use project (slug resolution)",
	"POST /projects":                                 "project create",
	"PATCH /projects/:id":                            "project update",
	"DELETE /projects/:id":                           "project delete",
	"GET /sync/:namespace":                           "project sync",
	"POST /projects/:id/icon":                        "project icon set",
	"POST /projects/:id/background-image":            "project background set",
	"POST /projects/:id/members":                     "project member add",
	"DELETE /projects/:id/members/:memberId":         "project member remove",
	"PATCH /projects/:id/members/:memberId":          "project member set-role",
	"DELETE /projects/:id/invitations/:invitationId": "project invitation revoke",

	// environments + shared vars
	"GET /projects/:projectId/environments":  "env list",
	"POST /projects/:projectId/environments": "env create",
	"DELETE /environments/:id":               "env delete",
	"POST /environments/:id/set-default":     "env set-default",
	"GET /environments/:id/shared-vars":      "env vars get",
	"PUT /environments/:id/shared-vars":      "env vars set",

	// deployments: lifecycle
	"GET /deployments":                               "deploy list",
	"GET /projects/:id/deployments":                  "deploy list (project scope)",
	"GET /deployments/:id":                           "deploy get",
	"POST /projects/:id/deployments":                 "deploy create --image",
	"POST /projects/:id/deployments/from-github":     "deploy create --github",
	"POST /projects/:id/deployments/from-local":      "up (local directory deploy)",
	"POST /deployments/:id/build-context":            "up (local build context upload)",
	"DELETE /deployments/:id":                        "deploy delete",
	"POST /deployments/:id/scale":                    "deploy scale",
	"POST /deployments/:id/restart":                  "deploy restart",
	"POST /deployments/:id/rebuild":                  "deploy rebuild",
	"POST /deployments/:id/cancel":                   "deploy cancel",
	"POST /deployments/:id/rollback/:imageHistoryId": "deploy rollback",
	"PATCH /deployments/:id/image":                   "deploy image set",

	// deployments: introspection
	"GET /deployments/:id/logs":                               "deploy logs --build",
	"GET /deployments/:id/pods":                               "deploy pods",
	"GET /deployments/:id/pods-live":                          "deploy pods --live",
	"GET /deployments/:id/metrics":                            "deploy metrics",
	"GET /deployments/:id/image-history":                      "deploy history",
	"GET /deployments/:id/image-history/:imageHistoryId/logs": "deploy history --logs",
	"GET /deployments/:id/killed-containers":                  "deploy killed list",
	"GET /deployments/:id/killed-containers/:entryId/logs":    "deploy killed logs",
	"GET /deployments/:id/github-deployments":                 "deploy github-deployments",

	// deployments: config
	"PUT /deployments/:id/env":          "deploy env set",
	"PATCH /deployments/:id/resources":  "deploy resources set",
	"PUT /deployments/:id/volumes":      "deploy volumes set",
	"PATCH /deployments/:id/strategy":   "deploy strategy set",
	"PUT /deployments/:id/health-check": "deploy health-check set",
	"PUT /deployments/:id/build-config": "deploy build-root set",

	// deployments: auto-deploy + webhook tokens
	"GET /deployments/:id/auto-deploy":                "deploy auto-deploy status",
	"POST /deployments/:id/auto-deploy/enable":        "deploy auto-deploy enable",
	"POST /deployments/:id/auto-deploy/disable":       "deploy auto-deploy disable",
	"GET /deployments/:id/webhook-tokens":             "deploy webhook-token list",
	"POST /deployments/:id/webhook-tokens":            "deploy webhook-token create",
	"DELETE /deployments/:id/webhook-tokens/:tokenId": "deploy webhook-token delete",
	"POST /webhooks/deploy":                           "webhook deploy",

	// services
	"POST /deployments/:deploymentId/services":                                   "service create",
	"PUT /deployments/:deploymentId/services/:serviceId":                         "service update",
	"DELETE /deployments/:deploymentId/services/:serviceId":                      "service delete",
	"PATCH /deployments/:deploymentId/services/:serviceId/exposure":              "service exposure set",
	"POST /deployments/:deploymentId/services/:serviceId/ports/:portId/public":   "service port public enable",
	"DELETE /deployments/:deploymentId/services/:serviceId/ports/:portId/public": "service port public disable",

	// domains (ingresses)
	"GET /ingresses/:id":                                  "domain get",
	"POST /deployments/:id/ingresses":                     "domain create",
	"PUT /deployments/:deploymentId/ingresses/:ingressId": "domain update (deployment-linked)",
	"PUT /projects/:id/ingresses/:ingressId":              "domain update (project-scoped)",
	"DELETE /projects/:id/ingresses/:ingressId":           "domain delete",
	"GET /projects/:id/ingresses/:ingressId/protection":   "domain protection get",
	"PUT /projects/:id/ingresses/:ingressId/protection":   "domain protection set",
	"POST /projects/ingresses/validate-dns":               "domain validate-dns",

	// databases
	"GET /databases":                         "db list",
	"GET /projects/:id/databases":            "db list (project scope)",
	"GET /databases/:id":                     "db get",
	"POST /projects/:id/databases":           "db create",
	"DELETE /databases/:id":                  "db delete",
	"GET /databases/:id/provisioning":        "db create --wait",
	"GET /databases/:id/metrics":             "db metrics",
	"GET /databases/:id/backups":             "db backup list",
	"POST /databases/:id/backups":            "db backup create",
	"POST /databases/:id/restore":            "db backup restore",
	"GET /databases/:id/backup-schedule":     "db backup-schedule get",
	"PUT /databases/:id/backup-schedule":     "db backup-schedule set",
	"DELETE /databases/:id/backup-schedule":  "db backup-schedule clear",
	"GET /databases/:id/extensions":          "db extension list",
	"POST /databases/:id/extensions":         "db extension install",
	"DELETE /databases/:id/extensions/:name": "db extension uninstall",
	"GET /databases/:id/settings":            "db settings get",
	"PATCH /databases/:id/settings":          "db settings set",
	"POST /databases/:id/public":             "db public enable",
	"DELETE /databases/:id/public":           "db public disable",
	"PATCH /databases/:id/resources":         "db resources set",
	"PATCH /databases/:id/storage":           "db storage expand",

	// pods
	"GET /pods":                "pod list",
	"GET /pods/:podName":       "pod get",
	"GET /pods/:podName/logs":  "pod logs",
	"DELETE /pods/:podName":    "pod delete",
	"POST /pods/:podName/exec": "pod exec",

	// sandboxes
	"GET /sandboxes":                                "sandbox list",
	"POST /sandboxes":                               "sandbox create",
	"GET /sandboxes/:id":                            "sandbox get",
	"PATCH /sandboxes/:id":                          "sandbox update",
	"POST /sandboxes/:id/start":                     "sandbox start",
	"POST /sandboxes/:id/stop":                      "sandbox stop",
	"DELETE /sandboxes/:id":                         "sandbox delete",
	"GET /sandboxes/:id/ssh":                        "sandbox ssh / sandbox proxy",
	"POST /sandboxes/:id/chat":                      "sandbox chat",
	"GET /sandboxes/:id/changes":                    "sandbox diff --stat",
	"GET /sandboxes/:id/diff":                       "sandbox diff",
	"GET /sandboxes/:id/repos":                      "sandbox repo list",
	"POST /sandboxes/:id/repos":                     "sandbox repo add",
	"GET /sandboxes/:id/conversations":              "sandbox conversations",
	"POST /sandboxes/:id/conversations":             "sandbox conversations --new",
	"PATCH /sandboxes/:id/conversations/:cid":       "sandbox conversations --rename",
	"DELETE /sandboxes/:id/conversations/:cid":      "sandbox conversations --delete",
	"GET /sandboxes/:id/conversations/:cid/history": "sandbox conversations --history",
	"ALL /sandboxes/:id/opencode/*":                 "sandbox chat (opencode workspace proxy, web UI)",
	"GET /sandboxes/credentials":                    "sandbox credentials status",
	"PUT /sandboxes/credentials":                    "sandbox credentials set",

	// ssh identities
	"GET /ssh-identities":                "ssh-identity list",
	"POST /ssh-identities":               "ssh-identity add",
	"POST /ssh-identities/import-github": "ssh-identity import-github",
	"DELETE /ssh-identities/:id":         "ssh-identity remove",

	// jobs + runs
	"GET /organizations/:orgId/jobs":         "job list (org scope)",
	"GET /projects/:projectId/jobs":          "job list (project scope)",
	"POST /projects/:projectId/jobs":         "job create",
	"GET /jobs/:id":                          "job get",
	"PATCH /jobs/:id":                        "job update",
	"DELETE /jobs/:id":                       "job delete",
	"PUT /jobs/:id/steps":                    "job steps set",
	"POST /jobs/:id/runs":                    "job run",
	"GET /jobs/:id/runs":                     "job runs",
	"GET /job-runs/:runId":                   "job-run get",
	"POST /job-runs/:runId/cancel":           "job-run cancel",
	"GET /job-runs/:runId/steps/:order/logs": "job-run logs",

	// templates
	"GET /templates":                               "template list",
	"GET /templates/:id":                           "template get",
	"POST /templates":                              "template admin create",
	"PUT /templates/:id":                           "template admin update",
	"DELETE /templates/:id":                        "template admin delete",
	"POST /projects/:projectId/template-instances": "template deploy",
	"GET /projects/:projectId/template-instances":  "template instance list",
	"GET /template-instances/:id":                  "template instance get",
	"DELETE /template-instances/:id":               "template instance delete",

	// compose stacks
	"GET /projects/:projectId/compose-stacks":              "compose list",
	"GET /compose-stacks/:id":                              "compose get",
	"POST /projects/:projectId/compose-stacks/from-github": "compose deploy",
	"POST /compose-stacks/:id/redeploy":                    "compose redeploy",
	"PUT /compose-stacks/:id/auto-deploy":                  "compose auto-deploy enable|disable",
	"DELETE /compose-stacks/:id":                           "compose delete",

	// github integration
	"GET /github/status":                                    "github status",
	"GET /github/link":                                      "github link (opens the browser here)",
	"DELETE /github/unlink":                                 "github unlink",
	"GET /github/app/install":                               "github install",
	"GET /github/app/installations":                         "github installations",
	"GET /github/repositories":                              "github repos",
	"GET /github/repositories/:owner/:repo/branches":        "github branches",
	"GET /github/repositories/:owner/:repo/contents":        "github contents",
	"GET /github/repositories/:owner/:repo/dockerfile-info": "github dockerfile-info",
	"GET /github/repositories/:owner/:repo/dockerfiles":     "github dockerfiles",

	// tailscale
	"GET /tailscale/status":                   "tailscale status",
	"POST /tailscale/link":                    "tailscale link",
	"DELETE /tailscale/unlink":                "tailscale unlink",
	"GET /tailscale/deployment/:deploymentId": "tailscale get",
	"POST /tailscale/expose/:deploymentId":    "tailscale expose",
	"POST /tailscale/unexpose/:deploymentId":  "tailscale unexpose",

	// observability
	"GET /events/orgs/:orgId":                        "events tail",
	"GET /observe/deployments/:id/overview":          "observe overview",
	"GET /observe/deployments/:id/logs/structured":   "observe logs",
	"GET /observe/deployments/:id/http-metrics":      "observe http",
	"GET /observe/deployments/:id/errors":            "observe errors",
	"GET /observe/deployments/:id/runtime":           "observe runtime",
	"GET /observe/deployments/:id/capabilities":      "observe capabilities",
	"GET /observe/deployments/:id/logs/stream":       "deploy logs --follow (SSE)",
	"GET /observe/deployments/:id/build-logs/stream": "deploy logs --build --follow (SSE)",

	// notification channels
	"GET /organizations/:id/notification-channels":                       "notify channel list",
	"POST /organizations/:id/notification-channels":                      "notify channel create",
	"PATCH /organizations/:id/notification-channels/:channelId":          "notify channel update",
	"DELETE /organizations/:id/notification-channels/:channelId":         "notify channel delete",
	"POST /organizations/:id/notification-channels/:channelId/test":      "notify channel test",
	"GET /organizations/:id/notification-channels/:channelId/deliveries": "notify deliveries",

	// audit
	"GET /audit-logs/organization/:id": "audit list",
	"GET /audit-logs/deployment/:id":   "audit list --deployment",

	// quota
	"GET /organizations/:orgId/quota":          "quota show",
	"GET /organizations/:orgId/quota/me":       "quota me",
	"GET /organizations/:orgId/quota/members":  "quota members",
	"GET /organizations/:orgId/quota/projects": "quota projects",

	// overview
	"GET /overview/orgs/:orgSlug":        "overview",
	"GET /overview/orgs/:orgSlug/builds": "overview --builds",
}

// routeExclusions lists non-superadmin routes the CLI deliberately does not
// call, with the reason. "no CLI command yet" entries are honest gaps: they
// stay visible here instead of silently rotting.
var routeExclusions = map[string]string{
	// browser login ceremonies: driven by redirects and cookies, not tokens
	"GET /auth/login":        "browser login ceremony",
	"GET /auth/callback":     "browser login ceremony (OAuth callback)",
	"GET /auth/logout":       "browser logout (CLI logout deletes the local token)",
	"POST /auth/otp/request": "browser OTP login ceremony",
	"POST /auth/otp/verify":  "browser OTP login ceremony",

	// WebAuthn: the ceremony requires a browser authenticator
	"GET /auth/passkey/check":                 "WebAuthn ceremony, browser only",
	"POST /auth/passkey/authenticate/options": "WebAuthn ceremony, browser only",
	"POST /auth/passkey/authenticate/verify":  "WebAuthn ceremony, browser only",
	"POST /auth/passkey/register/options":     "WebAuthn ceremony, browser only",
	"POST /auth/passkey/register/verify":      "WebAuthn ceremony, browser only",
	"GET /auth/passkeys":                      "passkey management: no CLI command yet (registration needs a browser)",
	"DELETE /auth/passkeys/:id":               "passkey management: no CLI command yet",
	"POST /auth/passkeys/:id/rename":          "passkey management: no CLI command yet",
	"POST /auth/mcp-token":                    "MCP session token minted during the web MCP handshake",

	// ingress protection: spoken by the protection proxy and the visitor's browser
	"GET /auth/protect/check":              "ingress protection proxy endpoint",
	"GET /auth/protect/info":               "ingress protection proxy endpoint",
	"POST /auth/protect/exchange/orchard":  "ingress protection browser exchange",
	"POST /auth/protect/exchange/password": "ingress protection browser exchange",

	// SSO + SCIM: IdP-driven enterprise endpoints, configured from the web UI
	"GET /sso/:orgId/login":                          "SSO browser flow",
	"GET /sso/:orgId/callback/oidc":                  "SSO IdP callback",
	"POST /sso/:orgId/callback/saml":                 "SSO IdP callback",
	"GET /sso/subdomain/:subdomain":                  "SSO subdomain resolver for the login page",
	"GET /organizations/:id/sso":                     "SSO admin config, web UI only",
	"PUT /organizations/:id/sso":                     "SSO admin config, web UI only",
	"DELETE /organizations/:id/sso":                  "SSO admin config, web UI only",
	"POST /organizations/:id/sso/test":               "SSO admin config, web UI only",
	"GET /organizations/:id/scim/tokens":             "SCIM admin config, web UI only",
	"POST /organizations/:id/scim/tokens":            "SCIM admin config, web UI only",
	"DELETE /organizations/:id/scim/tokens/:tokenId": "SCIM admin config, web UI only",
	"GET /scim/v2/Users":                             "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Users/:id":                         "SCIM protocol endpoint for IdPs",
	"POST /scim/v2/Users":                            "SCIM protocol endpoint for IdPs",
	"PUT /scim/v2/Users/:id":                         "SCIM protocol endpoint for IdPs",
	"PATCH /scim/v2/Users/:id":                       "SCIM protocol endpoint for IdPs",
	"DELETE /scim/v2/Users/:id":                      "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Groups":                            "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Groups/:id":                        "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ResourceTypes":                     "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ResourceTypes/:id":                 "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Schemas":                           "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/Schemas/:id":                       "SCIM protocol endpoint for IdPs",
	"GET /scim/v2/ServiceProviderConfig":             "SCIM protocol endpoint for IdPs",

	// github plumbing
	"GET /github/callback":     "GitHub OAuth callback, browser only",
	"POST /github/link":        "GitHub OAuth code exchange for the browser flow (CLI opens GET /github/link)",
	"POST /github/app/webhook": "webhook receiver for GitHub, not a client route",

	// server plumbing
	"GET /health":                  "health probe",
	"POST /webhooks/deploy/:token": "CLI sends the token via the Authorization header on POST /webhooks/deploy instead (the URL form leaks the secret into proxy logs); deploy webhook-token create prints this URL for curl-only CI",

	// web-UI-only conveniences
	"POST /ai/chat":                                  "web UI AI assistant",
	"GET /deployments/favicon":                       "web UI favicon proxy for deployment URLs",
	"GET /deployments/recent-builds":                 "web dashboard widget (CLI: overview --builds)",
	"GET /projects/by-slugs/:orgSlug/:projectSlug":   "web URL resolver (CLI resolves via GET /projects/slug/:slug)",
	"GET /organizations/:id/members/me":              "web UI permission preflight (CLI reads the members list)",
	"GET /organizations/:orgId/metrics/provisioning": "web UI provisioning banner",

	// browser invite landing (CLI acts by invitation id, not token)
	"GET /invitations/:token":          "browser invite landing page",
	"POST /invitations/:token/accept":  "browser invite landing page",
	"POST /invitations/:token/decline": "browser invite landing page",
	"POST /invitations/accept-pending": "deliberately non-bulk endpoint; invitation accept-all loops the by-id route",

	// superadmin in disguise: guard says authenticated, service requires superadmin
	"POST /organizations/:id/members/join": "superadmin-gated in the service layer",

	// honest gaps: no CLI command yet (reachable via `orchard api` meanwhile)
	"GET /audit-logs/global": "no CLI command yet: cross-org audit feed",
	"GET /endpoints":         "no CLI command yet: raw k8s endpoint listing per namespace",
	"GET /github/repositories/:owner/:repo/dockerfile-stages":    "no CLI command yet: dockerfile stage introspection",
	"PATCH /environments/:id":                                    "no CLI command yet: environment rename",
	"GET /projects/:id/ingresses/:ingressId":                     "duplicate read: CLI uses GET /ingresses/:id",
	"DELETE /deployments/:deploymentId/ingresses/:ingressId":     "duplicate delete: CLI uses the project-scoped route",
	"POST /projects/:id/ingresses":                               "project-level ingress create: CLI creates domains on deployments",
	"PATCH /organizations/:orgId/quota/default-member-allowance": "no CLI command yet: quota mutations",
	"PATCH /organizations/:orgId/quota/members/:userId":          "no CLI command yet: quota mutations",
	"PATCH /organizations/:orgId/quota/projects/:projectId":      "no CLI command yet: quota mutations",

	// honest gaps from the ui 2.0 wave (reachable via `orchard api` meanwhile)
	"GET /forum/categories":                                           "no CLI command yet: web UI community forum",
	"GET /forum/threads":                                              "no CLI command yet: web UI community forum",
	"GET /forum/threads/:id":                                          "no CLI command yet: web UI community forum",
	"POST /forum/threads":                                             "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id":                                       "no CLI command yet: web UI community forum",
	"POST /forum/threads/:id/replies":                                 "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id/replies/:replyId":                      "no CLI command yet: web UI community forum",
	"POST /forum/threads/:id/vote":                                    "no CLI command yet: web UI community forum",
	"DELETE /forum/threads/:id/vote":                                  "no CLI command yet: web UI community forum",
	"POST /forum/uploads":                                             "no CLI command yet: web UI community forum",
	"GET /organizations/:id/notification-rules":                       "no CLI command yet: notification rules",
	"POST /organizations/:id/notification-rules":                      "no CLI command yet: notification rules",
	"PATCH /organizations/:id/notification-rules/:ruleId":             "no CLI command yet: notification rules",
	"DELETE /organizations/:id/notification-rules/:ruleId":            "no CLI command yet: notification rules",
	"POST /organizations/:id/notification-channels/:channelId/replay": "no CLI command yet: notification delivery replay",
	"GET /users/me/notification-destinations":                         "no CLI command yet: personal notification destinations",
	"POST /users/me/notification-destinations":                        "no CLI command yet: personal notification destinations",
	"PUT /users/me/notification-destinations/:destinationId":          "no CLI command yet: personal notification destinations",
	"DELETE /users/me/notification-destinations/:destinationId":       "no CLI command yet: personal notification destinations",
	"POST /users/me/notification-destinations/:destinationId/test":    "no CLI command yet: personal notification destinations",
	"GET /users/me/notification-settings":                             "no CLI command yet: personal notification settings",
	"PUT /users/me/notification-settings":                             "no CLI command yet: personal notification settings",
	"GET /users/me/notification-settings/:scopeType/:scopeId":         "no CLI command yet: personal notification settings",
	"PUT /users/me/notification-settings/:scopeType/:scopeId":         "no CLI command yet: personal notification settings",
	"DELETE /users/me/notification-settings/:scopeType/:scopeId":      "no CLI command yet: personal notification settings",
	"GET /databases/:id/live":                                         "no CLI command yet: live database pod view",
	"GET /databases/:id/query-stats":                                  "no CLI command yet: database query stats",
	"POST /databases/:id/query-stats/reset":                           "no CLI command yet: database query stats",
	"POST /databases/:id/start":                                       "no CLI command yet: database lifecycle start/stop",
	"POST /databases/:id/stop":                                        "no CLI command yet: database lifecycle start/stop",
	"POST /databases/:id/restart":                                     "no CLI command yet: database lifecycle start/stop",
	"GET /deployments/:id/build-runs":                                 "no CLI command yet: build run history (CLI: deploy history)",
	"GET /deployments/:id/build-runs/:runId/logs":                     "no CLI command yet: build run history (CLI: deploy history --logs)",
	"GET /github/repositories/:owner/:repo/detect":                    "no CLI command yet: repo framework detection preview",
	"PATCH /observe/deployments/:id/errors/:fingerprint":              "no CLI command yet: error triage state mutations",
	"PATCH /deployments/:id/name":                                     "no CLI command yet: rename mutations",
	"PATCH /databases/:id/name":                                       "no CLI command yet: rename mutations",
	"PATCH /compose-stacks/:id/name":                                  "no CLI command yet: rename mutations",
	"PATCH /template-instances/:id/name":                              "no CLI command yet: rename mutations",
	"PATCH /auth/tokens/:id":                                          "no CLI command yet: token rename",
	"POST /auth/me/seen-updates":                                      "web UI changelog seen marker",
	"PUT /deployments/:id/github-repo":                                "no CLI command yet: relink the github repo",
}

func loadAuthSnapshot(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(authSnapshotPath))
	if err != nil {
		t.Fatalf("read auth-coverage snapshot: %v", err)
	}
	var snapshot map[string]string
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatalf("parse auth-coverage snapshot: %v", err)
	}
	if len(snapshot) < 200 {
		t.Fatalf("snapshot has only %d routes; expected the full route table", len(snapshot))
	}
	return snapshot
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestServerRouteParity is the forward gate: every in-scope server route must
// be mapped to a command or explicitly excluded.
func TestServerRouteParity(t *testing.T) {
	snapshot := loadAuthSnapshot(t)

	var total, superadmin, excluded, mapped int
	unmapped := []string{}
	for _, route := range sortedKeys(snapshot) {
		total++
		if snapshot[route] == "superadmin" {
			superadmin++
			continue
		}
		if _, ok := routeExclusions[route]; ok {
			excluded++
			continue
		}
		if _, ok := routeCoverage[route]; ok {
			mapped++
			continue
		}
		unmapped = append(unmapped, route+" ("+snapshot[route]+")")
	}
	t.Logf("routes: %d total, %d superadmin (skipped), %d excluded, %d mapped", total, superadmin, excluded, mapped)
	if len(unmapped) > 0 {
		t.Fatalf("new server route(s) without CLI parity: add a CLI command (and map it in routeCoverage) or an explicit routeExclusions entry in cmd/parity_test.go:\n  %s",
			strings.Join(unmapped, "\n  "))
	}
}

// TestParityMapsMatchSnapshot is the inverse gate: no stale or conflicting
// map entries survive a server route removal or rename.
func TestParityMapsMatchSnapshot(t *testing.T) {
	snapshot := loadAuthSnapshot(t)

	stale := []string{}
	for _, route := range sortedKeys(routeCoverage) {
		auth, ok := snapshot[route]
		switch {
		case !ok:
			stale = append(stale, route+" (mapped to `"+routeCoverage[route]+"` but gone from the snapshot: server route removed or renamed)")
		case auth == "superadmin":
			stale = append(stale, route+" (mapped to `"+routeCoverage[route]+"` but the snapshot marks it superadmin)")
		}
		if _, both := routeExclusions[route]; both {
			stale = append(stale, route+" (listed in both routeCoverage and routeExclusions)")
		}
	}
	for _, route := range sortedKeys(routeExclusions) {
		if _, ok := snapshot[route]; !ok {
			stale = append(stale, route+" (excluded but gone from the snapshot: drop the exclusion)")
		}
	}
	if len(stale) > 0 {
		t.Fatalf("stale parity map entrie(s) in cmd/parity_test.go:\n  %s", strings.Join(stale, "\n  "))
	}
}
