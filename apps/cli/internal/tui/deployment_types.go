package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// DepDetail is the full GET /deployments/:id shape. It supersedes the slim
// Deployment list struct for the detail screen: image history, services,
// volumes, and config all come embedded in the one response.
type DepDetail struct {
	ID                       string   `json:"id"`
	Name                     string   `json:"name"`
	Namespace                string   `json:"namespace"`
	Image                    string   `json:"image"`
	Replicas                 int      `json:"replicas"`
	AvailableReplicas        int      `json:"availableReplicas"`
	Status                   string   `json:"status"`
	BuildStatus              string   `json:"buildStatus"`
	BuildStep                string   `json:"buildStep"`
	BuildType                string   `json:"buildType"`
	DockerfilePath           string   `json:"dockerfilePath"`
	DockerfileTarget         string   `json:"dockerfileTarget"`
	GithubRepo               string   `json:"githubRepo"`
	GithubBranch             string   `json:"githubBranch"`
	DeployStrategy           string   `json:"deployStrategy"`
	ImagePullPolicy          string   `json:"imagePullPolicy"`
	EffectiveImagePullPolicy string   `json:"effectiveImagePullPolicy"`
	TotalCPUUsage            flexNum  `json:"totalCpuUsage"`
	TotalMemoryUsage         flexNum  `json:"totalMemoryUsage"`
	CPURequestMilli          *flexNum `json:"cpuRequestMilli"`
	MemoryRequestB           *flexNum `json:"memoryRequestBytes"`

	BuildFromRoot        bool `json:"buildFromRoot"`
	BuildWithDepot       bool `json:"buildWithDepot"`
	PersistentBuildCache bool `json:"persistentBuildCache"`

	AutoDeployEnabled bool     `json:"autoDeployEnabled"`
	AutoDeployBranch  string   `json:"autoDeployBranch"`
	AutoDeployPaths   []string `json:"autoDeployPaths"`

	HealthCheckEnabled      bool    `json:"healthCheckEnabled"`
	HealthCheckType         string  `json:"healthCheckType"`
	HealthCheckPath         string  `json:"healthCheckPath"`
	HealthCheckCommand      string  `json:"healthCheckCommand"`
	HealthCheckPort         flexNum `json:"healthCheckPort"`
	HealthCheckInterval     flexNum `json:"healthCheckInterval"`
	HealthCheckTimeout      flexNum `json:"healthCheckTimeout"`
	HealthCheckRetries      flexNum `json:"healthCheckRetries"`
	StartupFailureThreshold flexNum `json:"startupFailureThreshold"`
	LivenessEnabled         bool    `json:"livenessEnabled"`
	ReadinessEnabled        bool    `json:"readinessEnabled"`
	StartupEnabled          bool    `json:"startupEnabled"`
	HealthCheckOverride     bool    `json:"healthCheckOverride"`

	DockerfileHealthCheck *DockerfileHealthCheck `json:"dockerfileHealthCheck"`

	EnvVars      []EnvVar            `json:"envVars"`
	Ingresses    []DepIngress        `json:"ingresses"`
	Services     []DepService        `json:"services"`
	Volumes      []DepVolume         `json:"volumes"`
	ImageHistory []ImageHistoryEntry `json:"imageHistory"`
}

// The HEALTHCHECK the repo's Dockerfile declares. It is what the deployment
// probes with unless HealthCheckOverride is set.
type DockerfileHealthCheck struct {
	Command     []string `json:"command"`
	Interval    flexNum  `json:"interval"`
	Timeout     flexNum  `json:"timeout"`
	Retries     flexNum  `json:"retries"`
	StartPeriod flexNum  `json:"startPeriod"`
}

type DepIngress struct {
	ID             string `json:"id"`
	Host           string `json:"host"`
	Path           string `json:"path"`
	URL            string `json:"url"`
	TLSEnabled     bool   `json:"tlsEnabled"`
	ProtectionMode string `json:"protectionMode"`
	DeploymentID   string `json:"deploymentId"`
	ProjectID      string `json:"projectId"`
}

type DepPort struct {
	ID            string  `json:"id"`
	ServicePort   flexNum `json:"servicePort"`
	ContainerPort flexNum `json:"containerPort"`
	Protocol      string  `json:"protocol"`
	PublicEnabled bool    `json:"publicEnabled"`
	PublicPort    flexNum `json:"publicPort"`
	NodePort      flexNum `json:"nodePort"`
}

type DepService struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Type   string    `json:"type"`
	Domain string    `json:"domain"`
	Ports  []DepPort `json:"ports"`
}

// public reports whether the service is exposed outside the cluster.
func (s DepService) public() bool {
	switch lc(s.Type) {
	case "", "clusterip", "internal":
		return false
	}
	return true
}

type DepVolume struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	MountPath   string `json:"mountPath"`
	PvcName     string `json:"pvcName"`
	StorageSize string `json:"storageSize"`
	ReadOnly    bool   `json:"readOnly"`
}

type ImageHistoryEntry struct {
	ID            string `json:"id"`
	Image         string `json:"image"`
	Tag           string `json:"tag"`
	Branch        string `json:"branch"`
	CommitSha     string `json:"commitSha"`
	CommitMessage string `json:"commitMessage"`
	TriggerType   string `json:"triggerType"`
	CreatedAt     string `json:"createdAt"`
	IsActive      bool   `json:"isActive"`
}

type WebhookToken struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	CreatedAt string `json:"createdAt"`
}

type TailscaleInfo struct {
	Exposed  bool   `json:"exposed"`
	Hostname string `json:"hostname"`
	IP       string `json:"ip"`
	DNS      string `json:"dns"`
}

type QuotaBudget struct {
	CPUMilli    *flexNum `json:"cpuMilli"`
	MemoryBytes *flexNum `json:"memoryBytes"`
}

type QuotaMe struct {
	Allowance      QuotaBudget `json:"allowance"`
	Usage          QuotaBudget `json:"usage"`
	EffectiveLimit QuotaBudget `json:"effectiveLimit"`
	OrgCap         struct {
		CPULimitMilli    *flexNum `json:"cpuLimitMilli"`
		MemoryLimitBytes *flexNum `json:"memoryLimitBytes"`
	} `json:"orgCap"`
}

type AuditEntry struct {
	CreatedAt   string `json:"createdAt"`
	Action      string `json:"action"`
	TargetType  string `json:"targetType"`
	TargetLabel string `json:"targetLabel"`
	ActorEmail  string `json:"actorEmail"`
	Actor       struct {
		Username string `json:"username"`
		Email    string `json:"email"`
	} `json:"actor"`
}

func (e AuditEntry) actor() string {
	if e.Actor.Username != "" {
		return e.Actor.Username
	}
	if e.Actor.Email != "" {
		return e.Actor.Email
	}
	if e.ActorEmail != "" {
		return e.ActorEmail
	}
	return "system"
}

// ---- messages ----

type (
	tokensMsg struct {
		items []WebhookToken
		err   error
	}
	tokenCreatedMsg struct {
		token string
	}
	tailscaleMsg struct {
		info TailscaleInfo
		err  error
	}
	quotaMsg struct {
		q   QuotaMe
		err error
	}
	depAuditMsg struct {
		entries []AuditEntry
		err     error
	}
	shellDoneMsg struct{ err error }
)

// ---- fetch commands (paths mirror cmd/deploy*.go, cmd/domain.go, etc.) ----

func ctxBG() context.Context { return context.Background() }

func fetchWebhookTokens(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[WebhookToken](cl, "/deployments/"+url.PathEscape(id)+"/webhook-tokens")
		return tokensMsg{items, err}
	}
}

func fetchTailscale(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var info TailscaleInfo
		err := cl.GetJSON(context.Background(), "/tailscale/deployment/"+url.PathEscape(id), &info)
		return tailscaleMsg{info, err}
	}
}

func fetchQuotaMe(cl *api.Client, orgID string) tea.Cmd {
	if orgID == "" {
		return nil
	}
	return func() tea.Msg {
		var q QuotaMe
		err := cl.GetJSON(context.Background(), "/organizations/"+url.PathEscape(orgID)+"/quota/me", &q)
		return quotaMsg{q, err}
	}
}

func fetchDepAudit(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Entries []AuditEntry `json:"entries"`
		}
		err := cl.GetJSON(context.Background(), "/audit-logs/deployment/"+url.PathEscape(id)+"?limit=50", &raw)
		return depAuditMsg{raw.Entries, err}
	}
}

// createWebhookToken mints a trigger token; the secret is shown exactly once.
func createWebhookToken(cl *api.Client, id, label string) tea.Cmd {
	return func() tea.Msg {
		body := map[string]any{}
		if label != "" {
			body["label"] = label
		}
		var raw map[string]any
		err := cl.Send(context.Background(), "POST", "/deployments/"+url.PathEscape(id)+"/webhook-tokens", body, &raw)
		if err != nil {
			return formResult{err: err}
		}
		tok, _ := raw["token"].(string)
		return formResult{ok: tokenCreatedMsg{token: tok}}
	}
}

// ingressCNAME mirrors cmd/domain.go's expectedCNAME.
func ingressCNAME() string {
	if v := os.Getenv("ORCHARD_INGRESS_CNAME"); v != "" {
		return v
	}
	return "ingress.lfdl.ink"
}

// createDomain validates DNS for custom hosts (orchard *.a.lfdl.ink subdomains
// work immediately), then attaches the domain to the deployment.
func createDomain(cl *api.Client, projectID, depID, host, path string, servicePort int) tea.Cmd {
	return func() tea.Msg {
		if !strings.HasSuffix(host, ".a.lfdl.ink") {
			var res struct {
				Valid   bool   `json:"valid"`
				Message string `json:"message"`
			}
			body := map[string]any{"projectId": projectID, "domain": host}
			if err := cl.Send(context.Background(), "POST", "/projects/ingresses/validate-dns", body, &res); err != nil {
				return formResult{err: err}
			}
			if !res.Valid {
				msg := res.Message
				if msg == "" {
					msg = "dns is not ready"
				}
				return formResult{err: errInvalid(msg + " — point a CNAME at " + ingressCNAME())}
			}
		}
		body := map[string]any{"host": host, "path": path, "servicePort": servicePort, "tlsEnabled": true}
		err := cl.Send(context.Background(), "POST", "/deployments/"+url.PathEscape(depID)+"/ingresses", body, nil)
		return formResult{ok: actionMsg{text: "added " + host}, err: err}
	}
}

// parseMemBytes mirrors cmd/db.go's dbParseMemory (bytes or Ki/Mi/Gi/Ti).
func parseMemBytes(s string) (int64, error) {
	for suffix, mult := range map[string]int64{"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40} {
		if v, ok := strings.CutSuffix(s, suffix); ok {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n <= 0 {
				return 0, fmt.Errorf("invalid memory quantity %q", s)
			}
			return n * mult, nil
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid memory quantity %q (want bytes or Ki/Mi/Gi/Ti)", s)
	}
	return n, nil
}

// pvcVolumeName mirrors cmd/deploy_config.go's deployVolumeName.
func pvcVolumeName(mountPath string) string {
	s := strings.ToLower(strings.Trim(mountPath, "/"))
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		return "data"
	}
	return name
}

// volumesBody serializes volumes for PUT /deployments/:id/volumes.
func volumesBody(vols []DepVolume) map[string]any {
	out := make([]map[string]any, 0, len(vols))
	for _, v := range vols {
		typ := v.Type
		if typ == "" {
			typ = "pvc"
		}
		out = append(out, map[string]any{
			"name":        v.Name,
			"type":        typ,
			"mountPath":   v.MountPath,
			"pvcName":     v.PvcName,
			"storageSize": v.StorageSize,
		})
	}
	return map[string]any{"volumes": out}
}

func f64p(n *flexNum) (float64, bool) {
	if n == nil {
		return 0, false
	}
	return float64(*n), true
}

// depMetricsPayload is the deployment.metrics org-event payload
// (server/src/events/metrics-pusher.service.ts).
type depMetricsPayload struct {
	TotalCPUUsage    *flexNum `json:"totalCpuUsage"`
	TotalMemoryUsage *flexNum `json:"totalMemoryUsage"`
}

func parseMetricsPayload(raw json.RawMessage) (cpu, mem float64, ok bool) {
	if len(raw) == 0 {
		return 0, 0, false
	}
	var p depMetricsPayload
	if json.Unmarshal(raw, &p) != nil || p.TotalCPUUsage == nil || p.TotalMemoryUsage == nil {
		return 0, 0, false
	}
	return float64(*p.TotalCPUUsage), float64(*p.TotalMemoryUsage), true
}
