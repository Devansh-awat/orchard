package tui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

const depDetailJSON = `{
	"id":"d1","name":"api","namespace":"ns","status":"running","replicas":2,"availableReplicas":2,
	"image":"nginx:latest","githubRepo":"acme/api","githubBranch":"main","deployStrategy":"rollingUpdate",
	"buildType":"dockerfile","dockerfilePath":"Dockerfile","buildFromRoot":false,"buildWithDepot":false,
	"persistentBuildCache":true,"autoDeployEnabled":true,"autoDeployBranch":"main",
	"healthCheckEnabled":true,"healthCheckType":"http","healthCheckPath":"/healthz","healthCheckPort":8080,
	"healthCheckInterval":30,"healthCheckTimeout":5,"healthCheckRetries":3,
	"livenessEnabled":true,"readinessEnabled":true,"startupEnabled":false,"startupFailureThreshold":30,
	"totalCpuUsage":120,"totalMemoryUsage":104857600,"cpuRequestMilli":500,"memoryRequestBytes":"1073741824",
	"envVars":[{"key":"PORT","value":"8080"}],
	"ingresses":[{"id":"i1","host":"api.example.com","path":"/","tlsEnabled":true,"protectionMode":"none","deploymentId":"d1","projectId":"p1"}],
	"services":[{"id":"s1","name":"web","type":"ClusterIP","ports":[{"id":"pp1","servicePort":80,"containerPort":8080,"protocol":"TCP","publicEnabled":false}]}],
	"volumes":[{"name":"data","type":"pvc","mountPath":"/data","pvcName":"data","storageSize":"5Gi","readOnly":false}],
	"imageHistory":[
		{"id":"h1","image":"reg/api:2","tag":"2","branch":"main","commitSha":"abcdef1234567","commitMessage":"feat: two","createdAt":"2026-07-10T12:00:00Z","isActive":true},
		{"id":"h2","image":"reg/api:1","tag":"1","branch":"main","commitSha":"1234567abcdef","commitMessage":"feat: one","createdAt":"2026-07-01T12:00:00Z","isActive":false}
	]}`

func fakeDepAPI(t *testing.T) (*api.Client, *capture) {
	t.Helper()
	cap := &capture{hits: map[string]json.RawMessage{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io_ReadAll(r)
		cap.mu.Lock()
		cap.hits[r.Method+" "+r.URL.Path] = body
		cap.mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/apiv1/deployments/d1" && r.Method == "GET":
			w.Write([]byte(depDetailJSON))
		case p == "/apiv1/deployments/d1/pods":
			w.Write([]byte(`[{"name":"api-abc","namespace":"ns","status":"Running","ready":"1/1","age":"2h"},
				{"name":"api-def","namespace":"ns","status":"Running","ready":"1/1","age":"1h"}]`))
		case p == "/apiv1/deployments/d1/metrics":
			w.Write([]byte(`{"data":{"cpu":[{"timestamp":1,"value":100}],"memory":[{"timestamp":1,"value":1000}]}}`))
		case p == "/apiv1/deployments/d1/logs":
			w.Write([]byte(`{"logs":"build ok","status":"succeeded"}`))
		case p == "/apiv1/deployments/d1/webhook-tokens" && r.Method == "GET":
			w.Write([]byte(`[{"id":"t1","label":"ci","createdAt":"2026-07-01T00:00:00Z"}]`))
		case p == "/apiv1/deployments/d1/webhook-tokens" && r.Method == "POST":
			w.Write([]byte(`{"id":"t2","token":"sekrit-once"}`))
		case p == "/apiv1/tailscale/deployment/d1":
			w.Write([]byte(`{"exposed":false}`))
		case p == "/apiv1/organizations/o1/quota/me":
			w.Write([]byte(`{"allowance":{"cpuMilli":4000,"memoryBytes":8589934592},
				"usage":{"cpuMilli":1000,"memoryBytes":2147483648},
				"effectiveLimit":{"cpuMilli":3000,"memoryBytes":6442450944},
				"orgCap":{"cpuLimitMilli":8000,"memoryLimitBytes":17179869184}}`))
		case p == "/apiv1/audit-logs/deployment/d1":
			w.Write([]byte(`{"entries":[{"createdAt":"2026-07-02T10:00:00Z","action":"deployment.scale","targetType":"deployment","targetLabel":"api","actor":{"username":"seb"}}]}`))
		case p == "/apiv1/projects/ingresses/validate-dns":
			w.Write([]byte(`{"valid":false,"message":"dns not ready"}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), cap
}

func newTestDepScreen(t *testing.T) (*deploymentScreen, *capture) {
	t.Helper()
	cl, cap := fakeDepAPI(t)
	d := newDeploymentScreen(cl, Project{ID: "p1", Name: "web", OrganizationID: "o1"}, "d1", "api")
	var s screen = d
	s, _ = s.Update(tea.WindowSizeMsg{Width: 140, Height: 45})
	s, _ = s.Update(run(fetchDetail(cl, "d1")))
	s, _ = s.Update(run(fetchPods(cl, "d1")))
	s, _ = s.Update(run(fetchMetrics(cl, "d1")))
	s, _ = s.Update(run(fetchLogs(cl, "d1")))
	_ = s
	return d, cap
}

func depKey(t *testing.T, d *deploymentScreen, k string) tea.Cmd {
	t.Helper()
	var msg tea.KeyMsg
	switch k {
	case "esc":
		msg = tea.KeyMsg{Type: tea.KeyEsc}
	case "enter":
		msg = tea.KeyMsg{Type: tea.KeyEnter}
	default:
		msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
	_, cmd := d.Update(msg)
	return cmd
}

// runMsgs executes cmd (flattening one level of tea.Batch) and feeds every
// produced message back into the screen.
func runMsgs(t *testing.T, d *deploymentScreen, cmd tea.Cmd) {
	t.Helper()
	if cmd == nil {
		return
	}
	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); ok {
		for _, c := range batch {
			if c != nil {
				d.Update(c())
			}
		}
		return
	}
	d.Update(msg)
}

func hitBody(cap *capture, key string) (string, bool) {
	cap.mu.Lock()
	defer cap.mu.Unlock()
	b, ok := cap.hits[key]
	return string(b), ok
}

func TestDeploymentTabCyclingAndNumbers(t *testing.T) {
	d, _ := newTestDepScreen(t)
	depKey(t, d, "]")
	if d.tab != tabEnv {
		t.Fatalf("] should advance to Env, got %d", d.tab)
	}
	depKey(t, d, "[")
	if d.tab != tabOverview {
		t.Fatalf("[ should go back to Overview, got %d", d.tab)
	}
	depKey(t, d, "7")
	if d.tab != tabAdvanced {
		t.Fatalf("7 should jump to Advanced, got %d", d.tab)
	}
	depKey(t, d, "1")
	if d.tab != tabOverview {
		t.Fatalf("1 should jump to Overview, got %d", d.tab)
	}
}

func TestOverviewFoldsPodsAndLogs(t *testing.T) {
	d, _ := newTestDepScreen(t)
	v := d.View()
	for _, want := range []string{"api-abc", "Logs", "follow", "api.example.com"} {
		if !strings.Contains(v, want) {
			t.Fatalf("overview missing %q:\n%s", want, v)
		}
	}
	// f toggles follow off
	if cmd := depKey(t, d, "f"); cmd == nil || d.follow {
		t.Fatal("f should turn follow off and flash")
	}
	if !strings.Contains(d.View(), "follow off") {
		t.Fatal("logs panel should show follow off")
	}
}

func TestDeploysTabRollbackAndTokens(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "3")) // enter Deploys → fetches webhook tokens
	v := d.View()
	for _, want := range []string{"reg/api:2", "active", "Webhook tokens", "ci", "auto-deploy"} {
		if !strings.Contains(v, want) {
			t.Fatalf("deploys tab missing %q:\n%s", want, v)
		}
	}

	// active entry refuses rollback
	if cmd := depKey(t, d, "R"); cmd == nil || d.confirm.Active() {
		t.Fatal("rollback of the active image should just flash")
	}
	// select the older entry and rollback through the confirm modal
	depKey(t, d, "j")
	depKey(t, d, "R")
	if !d.confirm.Active() {
		t.Fatal("R should arm the rollback confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if _, ok := hitBody(cap, "POST /apiv1/deployments/d1/rollback/h2"); !ok {
		t.Fatal("rollback endpoint not hit")
	}

	// token pane: delete the selected token
	depKey(t, d, "p")
	depKey(t, d, "x")
	if !d.confirm.Active() {
		t.Fatal("x should arm the token delete confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if _, ok := hitBody(cap, "DELETE /apiv1/deployments/d1/webhook-tokens/t1"); !ok {
		t.Fatal("token delete endpoint not hit")
	}

	// minted token secret is surfaced once
	d.Update(tokenCreatedMsg{token: "sekrit-once"})
	if !strings.Contains(d.View(), "sekrit-once") {
		t.Fatal("new token secret should render in the tokens pane")
	}
}

func TestAutoDeployToggle(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "3"))
	depKey(t, d, "a") // enabled → confirm disable
	if !d.confirm.Active() {
		t.Fatal("a should arm the auto-deploy disable confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if _, ok := hitBody(cap, "POST /apiv1/deployments/d1/auto-deploy/disable"); !ok {
		t.Fatal("auto-deploy disable endpoint not hit")
	}

	// disabled → pushes the branch form
	d.detail.AutoDeployEnabled = false
	cmd := depKey(t, d, "a")
	if cmd == nil {
		t.Fatal("a should open the enable form when auto-deploy is off")
	}
	if _, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("expected a pushScreen for the auto-deploy branch form")
	}
}

func TestNetworkTabServicesDomainsTailscale(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "4")) // enter Network → fetches tailscale
	v := d.View()
	for _, want := range []string{"web", "80->8080", "api.example.com", "Tailscale", "not exposed"} {
		if !strings.Contains(v, want) {
			t.Fatalf("network tab missing %q:\n%s", want, v)
		}
	}

	// expose the internal service
	runMsgs(t, d, depKey(t, d, "e"))
	if body, ok := hitBody(cap, "PATCH /apiv1/deployments/d1/services/s1/exposure"); !ok || !strings.Contains(body, `"exposePublic":true`) {
		t.Fatalf("service exposure not toggled, body=%q", body)
	}

	// protection cycler: none → orchard
	depKey(t, d, "p")
	runMsgs(t, d, depKey(t, d, "m"))
	if body, ok := hitBody(cap, "PUT /apiv1/projects/p1/ingresses/i1/protection"); !ok || !strings.Contains(body, `"mode":"orchard"`) {
		t.Fatalf("protection mode not set to orchard, body=%q", body)
	}
	// orchard → password detours through a form
	d.detail.Ingresses[0].ProtectionMode = "orchard"
	cmd := depKey(t, d, "m")
	if cmd == nil {
		t.Fatal("cycling into password mode should push the password form")
	}
	if _, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("expected pushScreen for the password form")
	}

	// domain delete via confirm
	depKey(t, d, "x")
	if !d.confirm.Active() {
		t.Fatal("x should arm the domain delete confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if _, ok := hitBody(cap, "DELETE /apiv1/projects/p1/ingresses/i1"); !ok {
		t.Fatal("domain delete endpoint not hit")
	}

	// tailscale expose
	runMsgs(t, d, depKey(t, d, "t"))
	if _, ok := hitBody(cap, "POST /apiv1/tailscale/expose/d1"); !ok {
		t.Fatal("tailscale expose endpoint not hit")
	}
}

func TestDomainFormValidatesDNS(t *testing.T) {
	cl, cap := fakeDepAPI(t)
	f := newDomainForm(cl, "p1", "d1")
	f.fields[0].ti.SetValue("shop.example.com")
	_, cmd := f.doSubmit()
	res, ok := run(cmd).(formResult)
	if !ok || res.err == nil || !strings.Contains(res.err.Error(), "dns not ready") {
		t.Fatalf("custom domain with bad DNS should fail, got %+v", res)
	}
	if _, ok := hitBody(cap, "POST /apiv1/deployments/d1/ingresses"); ok {
		t.Fatal("ingress must not be created when DNS validation fails")
	}

	// orchard subdomains skip validation entirely
	f2 := newDomainForm(cl, "p1", "d1")
	f2.fields[0].ti.SetValue("myapp.a.lfdl.ink")
	_, cmd = f2.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("orchard subdomain create failed: %+v", res)
	}
	body, ok := hitBody(cap, "POST /apiv1/deployments/d1/ingresses")
	if !ok || !strings.Contains(body, `"host":"myapp.a.lfdl.ink"`) || !strings.Contains(body, `"tlsEnabled":true`) {
		t.Fatalf("ingress create body wrong: %q", body)
	}
}

func TestStorageTabAddRemoveVolume(t *testing.T) {
	d, cap := newTestDepScreen(t)
	depKey(t, d, "5")
	v := d.View()
	if !strings.Contains(v, "/data") || !strings.Contains(v, "5Gi") {
		t.Fatalf("storage tab missing volume:\n%s", v)
	}

	// remove the only volume → PUT with an empty set
	depKey(t, d, "x")
	if !d.confirm.Active() {
		t.Fatal("x should arm the volume removal confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if body, ok := hitBody(cap, "PUT /apiv1/deployments/d1/volumes"); !ok || !strings.Contains(body, `"volumes":[]`) {
		t.Fatalf("volume removal should PUT an empty list, body=%q", body)
	}

	// add form appends to the existing set
	f := newVolumeForm(d.cl, "d1", d.detail.Volumes)
	f.fields[0].ti.SetValue("/cache")
	f.fields[1].ti.SetValue("1Gi")
	_, cmd := f.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("volume add failed: %+v", res)
	}
	body, _ := hitBody(cap, "PUT /apiv1/deployments/d1/volumes")
	if !strings.Contains(body, `"mountPath":"/cache"`) || !strings.Contains(body, `"mountPath":"/data"`) {
		t.Fatalf("volume add should keep existing volumes, body=%q", body)
	}

	// duplicate mount is rejected client-side
	f2 := newVolumeForm(d.cl, "d1", d.detail.Volumes)
	f2.fields[0].ti.SetValue("/data")
	f2.fields[1].ti.SetValue("1Gi")
	_, cmd = f2.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err == nil {
		t.Fatal("duplicate mount path should be rejected")
	}
}

func TestResourcesTabQuotaAndEditor(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "6")) // fetches quota + metrics
	v := d.View()
	for _, want := range []string{"quota budget", "500m", "1.0 GiB", "Headroom"} {
		if !strings.Contains(v, want) {
			t.Fatalf("resources tab missing %q:\n%s", want, v)
		}
	}

	f := newResourcesForm(d.cl, "d1", d.detail)
	f.fields[0].ti.SetValue("750")
	f.fields[1].ti.SetValue("512Mi")
	_, cmd := f.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("resources submit failed: %+v", res)
	}
	body, _ := hitBody(cap, "PATCH /apiv1/deployments/d1/resources")
	if !strings.Contains(body, `"cpuRequestMilli":750`) || !strings.Contains(body, `"memoryRequestBytes":536870912`) {
		t.Fatalf("resources body wrong: %q", body)
	}

	// empty fields clear to the org default (explicit nulls)
	f2 := newResourcesForm(d.cl, "d1", d.detail)
	f2.fields[0].ti.SetValue("")
	f2.fields[1].ti.SetValue("")
	_, cmd = f2.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("resources clear failed: %+v", res)
	}
	body, _ = hitBody(cap, "PATCH /apiv1/deployments/d1/resources")
	if !strings.Contains(body, `"cpuRequestMilli":null`) || !strings.Contains(body, `"memoryRequestBytes":null`) {
		t.Fatalf("clearing should send nulls: %q", body)
	}
}

func TestAdvancedTabTogglesAndAudit(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "7")) // fetches the audit log
	v := d.View()
	for _, want := range []string{"rollingUpdate", "deployment.scale", "seb", "Audit log"} {
		if !strings.Contains(v, want) {
			t.Fatalf("advanced tab missing %q:\n%s", want, v)
		}
	}

	// strategy toggle rollingUpdate → recreate
	runMsgs(t, d, depKey(t, d, "t"))
	if body, ok := hitBody(cap, "PATCH /apiv1/deployments/d1/strategy"); !ok || !strings.Contains(body, `"strategy":"recreate"`) {
		t.Fatalf("strategy toggle body wrong: %q", body)
	}
	// PVC-backed deployments cannot go back to rollingUpdate
	d.detail.DeployStrategy = "recreate"
	if cmd := depKey(t, d, "t"); cmd == nil {
		t.Fatal("blocked strategy toggle should flash an error")
	} else if fl, ok := run(cmd).(flash); !ok || !fl.isErr {
		t.Fatalf("expected an error flash, got %T", run(cmd))
	}

	// build config toggles PUT the full config with one flip
	runMsgs(t, d, depKey(t, d, "g"))
	body, _ := hitBody(cap, "PUT /apiv1/deployments/d1/build-config")
	if !strings.Contains(body, `"buildFromRoot":true`) || !strings.Contains(body, `"persistentBuildCache":true`) {
		t.Fatalf("build-root toggle body wrong: %q", body)
	}
	runMsgs(t, d, depKey(t, d, "D"))
	body, _ = hitBody(cap, "PUT /apiv1/deployments/d1/build-config")
	if !strings.Contains(body, `"buildWithDepot":true`) {
		t.Fatalf("depot toggle body wrong: %q", body)
	}

	// cancel build goes through the confirm modal
	depKey(t, d, "C")
	if !d.confirm.Active() {
		t.Fatal("C should arm the cancel-build confirmation")
	}
	runMsgs(t, d, depKey(t, d, "y"))
	if _, ok := hitBody(cap, "POST /apiv1/deployments/d1/cancel"); !ok {
		t.Fatal("cancel endpoint not hit")
	}
}

func TestHealthCheckFormPutsFullConfig(t *testing.T) {
	d, cap := newTestDepScreen(t)
	f := newHealthCheckForm(d.cl, "d1", d.detail)
	// prefilled from the deployment; flip enabled off
	f.fields[0].ti.SetValue("off")
	_, cmd := f.doSubmit()
	if res, ok := run(cmd).(formResult); !ok || res.err != nil {
		t.Fatalf("health check submit failed: %+v", res)
	}
	body, _ := hitBody(cap, "PUT /apiv1/deployments/d1/health-check")
	for _, want := range []string{`"healthCheckEnabled":false`, `"healthCheckPath":"/healthz"`, `"livenessEnabled":true`, `"startupFailureThreshold":30`} {
		if !strings.Contains(body, want) {
			t.Fatalf("health check body missing %s: %q", want, body)
		}
	}
}

func TestShellPickerAndExecScopeDegradation(t *testing.T) {
	d, _ := newTestDepScreen(t)
	// two pods → s arms the picker instead of connecting
	if cmd := depKey(t, d, "s"); cmd != nil || !d.shellPicking {
		t.Fatal("s with several pods should open the pod picker")
	}
	if !strings.Contains(d.View(), "Open shell in pod") {
		t.Fatal("picker overlay missing from the view")
	}
	if h := d.help(); h[1][1] != "open shell" {
		t.Fatalf("keybar should show picker hints, got %+v", h)
	}
	depKey(t, d, "j")
	if d.shellPick != 1 {
		t.Fatalf("j should move the picker cursor, got %d", d.shellPick)
	}
	depKey(t, d, "esc")
	if d.shellPicking {
		t.Fatal("esc should dismiss the picker")
	}

	// a 403 marks the token exec-less and hides the shell hint
	hasShellHint := func() bool {
		for _, h := range d.help() {
			if h[1] == "shell" {
				return true
			}
		}
		return false
	}
	if !hasShellHint() {
		t.Fatal("shell hint should show before any 403")
	}
	d.Update(shellDoneMsg{err: &api.APIError{Status: 403, Message: "forbidden"}})
	if !d.execDenied || hasShellHint() {
		t.Fatal("403 should hide the shell hint")
	}
	if cmd := depKey(t, d, "s"); cmd == nil || d.shellPicking {
		t.Fatal("s after a 403 should flash instead of opening the picker")
	}
}

func TestOnOrgEventRoutesPerType(t *testing.T) {
	d, _ := newTestDepScreen(t)
	if cmd := d.OnOrgEvent(api.OrgEvent{Type: "deployment.changed", ID: "other"}); cmd != nil {
		t.Fatal("events for other deployments must be ignored")
	}
	if cmd := d.OnOrgEvent(api.OrgEvent{Type: "deployment.changed", ID: "d1"}); cmd == nil {
		t.Fatal("deployment.changed should trigger a refetch")
	}
	if cmd := d.OnOrgEvent(api.OrgEvent{Type: "pod.changed", ID: "d1"}); cmd == nil {
		t.Fatal("pod.changed should refetch pods")
	}

	// a parseable metrics payload feeds the graphs without any refetch
	before := len(d.metrics.Data.CPU)
	ev := api.OrgEvent{Type: "deployment.metrics", ID: "d1",
		Payload: json.RawMessage(`{"totalCpuUsage":321,"totalMemoryUsage":654}`)}
	if cmd := d.OnOrgEvent(ev); cmd != nil {
		t.Fatal("parseable metrics payload should not refetch")
	}
	cpu := d.metrics.Data.CPU
	if len(cpu) != before+1 || cpu[len(cpu)-1].Value != 321 {
		t.Fatalf("metrics point not pushed: %+v", cpu)
	}
	if float64(d.detail.TotalCPUUsage) != 321 || float64(d.detail.TotalMemoryUsage) != 654 {
		t.Fatal("headline usage not updated from the payload")
	}

	// garbage payload falls back to a refetch
	bad := api.OrgEvent{Type: "deployment.metrics", ID: "d1", Payload: json.RawMessage(`"nope"`)}
	if cmd := d.OnOrgEvent(bad); cmd == nil {
		t.Fatal("unparseable metrics payload should refetch")
	}
}

func TestEnvTabOpensEditor(t *testing.T) {
	d, _ := newTestDepScreen(t)
	depKey(t, d, "2")
	if !strings.Contains(d.View(), "PORT") {
		t.Fatal("env tab should list variables")
	}
	cmd := depKey(t, d, "e")
	if cmd == nil {
		t.Fatal("e should open the env editor")
	}
	pushed, ok := run(cmd).(pushScreen)
	if !ok {
		t.Fatal("expected a pushScreen")
	}
	if _, ok := pushed.s.(*envScreen); !ok {
		t.Fatalf("expected the env editor screen, got %T", pushed.s)
	}
}

func TestOverviewQuickScaleAndShellSinglePod(t *testing.T) {
	d, cap := newTestDepScreen(t)
	runMsgs(t, d, depKey(t, d, "+"))
	if body, ok := hitBody(cap, "POST /apiv1/deployments/d1/scale"); !ok || !strings.Contains(body, `"replicas":3`) {
		t.Fatalf("+ should scale up by one, body=%q", body)
	}
	runMsgs(t, d, depKey(t, d, "-"))
	if body, _ := hitBody(cap, "POST /apiv1/deployments/d1/scale"); !strings.Contains(body, `"replicas":1`) {
		t.Fatalf("- should scale down by one, body=%q", body)
	}
	// with a single pod, s connects straight away (tea.Exec command)
	d.pods = d.pods[:1]
	if cmd := depKey(t, d, "s"); cmd == nil || d.shellPicking {
		t.Fatal("s with one pod should return the exec command directly")
	}
}
