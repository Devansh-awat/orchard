package tui

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// Advanced tab: update strategy, health checks, build configuration, build
// cancellation, and the deployment-scoped audit log.

func (s *deploymentScreen) advancedKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	d := s.detail
	switch msg.String() {
	case "up", "k":
		if s.auditCursor > 0 {
			s.auditCursor--
		}
		return nil, true
	case "down", "j":
		if s.auditCursor < len(s.audit)-1 {
			s.auditCursor++
		}
		return nil, true
	case "t":
		if d == nil {
			return nil, true
		}
		next := "recreate"
		if lc(d.DeployStrategy) == "recreate" {
			next = "rollingUpdate"
		}
		if len(d.Volumes) > 0 && next == "rollingUpdate" {
			return errFlash(errInvalid("PVC-backed deployments require the recreate strategy")), true
		}
		return doAction(s.cl, "PATCH", "/deployments/"+url.PathEscape(s.id)+"/strategy",
			map[string]any{"strategy": next}, "strategy set to "+next), true
	case "h":
		if d != nil {
			return push(newHealthCheckForm(s.cl, s.id, d)), true
		}
		return nil, true
	case "g":
		return s.buildConfigCmd(func(b map[string]any, d *DepDetail) string {
			b["buildFromRoot"] = !d.BuildFromRoot
			return "build-from-root " + onOffPlain(!d.BuildFromRoot)
		}), true
	case "D":
		return s.buildConfigCmd(func(b map[string]any, d *DepDetail) string {
			b["buildWithDepot"] = !d.BuildWithDepot
			return "depot builds " + onOffPlain(!d.BuildWithDepot)
		}), true
	case "c":
		return s.buildConfigCmd(func(b map[string]any, d *DepDetail) string {
			b["persistentBuildCache"] = !d.PersistentBuildCache
			return "persistent build cache " + onOffPlain(!d.PersistentBuildCache)
		}), true
	case "C":
		s.confirm.Show("Cancel the in-progress build?",
			doAction(s.cl, "POST", "/deployments/"+url.PathEscape(s.id)+"/cancel", nil, "build cancelled"))
		return nil, true
	}
	return nil, false
}

func onOffPlain(v bool) string {
	if v {
		return "on"
	}
	return "off"
}

// buildConfigCmd sends the full build config with one toggle applied
// (PUT /deployments/:id/build-config, mirroring cmd/deploy_config.go).
func (s *deploymentScreen) buildConfigCmd(mutate func(map[string]any, *DepDetail) string) tea.Cmd {
	d := s.detail
	if d == nil {
		return nil
	}
	body := map[string]any{
		"buildFromRoot":        d.BuildFromRoot,
		"buildWithDepot":       d.BuildWithDepot,
		"persistentBuildCache": d.PersistentBuildCache,
	}
	text := mutate(body, d)
	return doAction(s.cl, "PUT", "/deployments/"+url.PathEscape(s.id)+"/build-config", body, text)
}

func (s *deploymentScreen) viewAdvanced(height int, strip string) string {
	d := s.detail
	if d == nil {
		return panelRaw(strip, stMuted.Render("  no data"), s.w, height, true)
	}
	cfgH := 9
	if cfgH > height-4 {
		cfgH = max(height-4, 3)
	}
	auditH := height - cfgH

	var b strings.Builder
	row := func(k, v string) {
		b.WriteString(" " + stKey.Render(pad(k, 14)) + " " + v + "\n")
	}
	strategy := d.DeployStrategy
	if strategy == "" {
		strategy = "rollingUpdate"
	}
	row("Strategy", stTitle.Render(strategy)+stMuted.Render("  (t toggles)"))

	pullPolicy := d.ImagePullPolicy
	if pullPolicy == "" {
		pullPolicy = "IfNotPresent"
	}
	row("Pull policy", stTitle.Render(pullPolicy))

	hc := onOff(d.HealthCheckEnabled)
	if d.HealthCheckEnabled {
		target := d.HealthCheckPath
		if lc(d.HealthCheckType) == "exec" {
			target = d.HealthCheckCommand
		}
		if p := int(d.HealthCheckPort); p > 0 {
			target += fmt.Sprintf(":%d", p)
		}
		hc += stMuted.Render(fmt.Sprintf("  %s %s · every %ss · timeout %ss · retries %s",
			orDash(d.HealthCheckType), orDash(target),
			fmtInt(d.HealthCheckInterval), fmtInt(d.HealthCheckTimeout), fmtInt(d.HealthCheckRetries)))
	}
	row("Health check", hc)

	if d.GithubRepo != "" {
		row("Build", stMuted.Render(fmt.Sprintf("%s · dockerfile %s", orDash(d.BuildType), orDash(d.DockerfilePath))))
		row("Build root", onOff(d.BuildFromRoot)+stMuted.Render("  (g)"))
		row("Depot", onOff(d.BuildWithDepot)+stMuted.Render("  (D)"))
		row("Build cache", onOff(d.PersistentBuildCache)+stMuted.Render("  (c)"))
	}
	bs := d.BuildStatus
	if bs == "" {
		bs = "—"
	}
	row("Build status", statusDot(bs))

	var a strings.Builder
	if s.auditErr != nil {
		a.WriteString("  " + stRed.Render("✗ "+s.auditErr.Error()))
	} else {
		rows := make([][]string, len(s.audit))
		for i, e := range s.audit {
			target := e.TargetLabel
			if target == "" {
				target = e.TargetType
			}
			rows[i] = []string{
				stMuted.Render(fmtDate(e.CreatedAt)),
				e.actor(),
				stKey.Render(e.Action),
				stMuted.Render(truncate(target, 40)),
			}
		}
		a.WriteString(renderTable([]col{{title: "WHEN"}, {title: "ACTOR"}, {title: "ACTION"}, {title: "TARGET"}},
			rows, s.auditCursor, s.w-2, auditH-2))
	}

	cfg := panelRaw(strip, b.String(), s.w, cfgH, true)
	audit := panel(fmt.Sprintf("Audit log (%d)", len(s.audit)), a.String(), s.w, auditH, false)
	return cfg + "\n" + audit
}

// newHealthCheckForm PUTs the full health-check config, starting from the
// deployment's current values (the endpoint replaces the whole object).
func newHealthCheckForm(cl *api.Client, depID string, d *DepDetail) *formScreen {
	set := func(f *field, v string) *field {
		if v != "" {
			f.ti.SetValue(v)
		}
		return f
	}
	numOr := func(n flexNum, def int) string {
		if int(n) > 0 {
			return strconv.Itoa(int(n))
		}
		return strconv.Itoa(def)
	}
	fields := []*field{
		set(fld("enabled", "Enabled (on/off)", "on", true), onOffPlain(d.HealthCheckEnabled)),
		set(fld("type", "Type (http/tcp/exec)", "http", false), d.HealthCheckType),
		set(fld("path", "HTTP path", "/healthz", false), d.HealthCheckPath),
		set(fld("port", "Port", "8080", false), numOrEmpty(d.HealthCheckPort)),
		set(fld("interval", "Interval seconds", "30", false), numOr(d.HealthCheckInterval, 30)),
		set(fld("timeout", "Timeout seconds", "5", false), numOr(d.HealthCheckTimeout, 5)),
		set(fld("retries", "Retries", "3", false), numOr(d.HealthCheckRetries, 3)),
	}
	base := map[string]any{
		"healthCheckEnabled":      d.HealthCheckEnabled,
		"healthCheckType":         strOr(d.HealthCheckType, "http"),
		"livenessEnabled":         d.LivenessEnabled,
		"readinessEnabled":        d.ReadinessEnabled,
		"startupEnabled":          d.StartupEnabled,
		"healthCheckInterval":     intOr(d.HealthCheckInterval, 30),
		"healthCheckTimeout":      intOr(d.HealthCheckTimeout, 5),
		"healthCheckRetries":      intOr(d.HealthCheckRetries, 3),
		"startupFailureThreshold": intOr(d.StartupFailureThreshold, 30),
	}
	if d.HealthCheckPath != "" {
		base["healthCheckPath"] = d.HealthCheckPath
	}
	if p := int(d.HealthCheckPort); p > 0 {
		base["healthCheckPort"] = p
	}
	if d.HealthCheckCommand != "" {
		base["healthCheckCommand"] = d.HealthCheckCommand
	}
	return newForm("Health check",
		"Configures liveness/readiness probes (PUT replaces the whole config).",
		fields,
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{}
				for k, val := range base {
					body[k] = val
				}
				switch lc(v["enabled"]) {
				case "on", "true", "yes":
					body["healthCheckEnabled"] = true
				case "off", "false", "no":
					body["healthCheckEnabled"] = false
				default:
					return formResult{err: errInvalid("enabled must be on or off")}
				}
				if v["type"] != "" {
					body["healthCheckType"] = v["type"]
				}
				if v["path"] != "" {
					body["healthCheckPath"] = v["path"]
				}
				for k, key := range map[string]string{
					"port": "healthCheckPort", "interval": "healthCheckInterval",
					"timeout": "healthCheckTimeout", "retries": "healthCheckRetries",
				} {
					if v[k] == "" {
						continue
					}
					n, err := strconv.Atoi(v[k])
					if err != nil || n <= 0 {
						return formResult{err: errInvalid(k + " must be a positive number")}
					}
					body[key] = n
				}
				err := cl.Send(ctxBG(), "PUT", "/deployments/"+url.PathEscape(depID)+"/health-check", body, nil)
				return formResult{ok: actionMsg{text: "health check updated"}, err: err}
			}
		})
}

func numOrEmpty(n flexNum) string {
	if int(n) > 0 {
		return strconv.Itoa(int(n))
	}
	return ""
}

func strOr(s, def string) string {
	if s != "" {
		return s
	}
	return def
}

func intOr(n flexNum, def int) int {
	if int(n) > 0 {
		return int(n)
	}
	return def
}
