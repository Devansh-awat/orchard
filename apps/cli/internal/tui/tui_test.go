package tui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

type capture struct {
	mu   sync.Mutex
	hits map[string]json.RawMessage
}

func fakeAPI(t *testing.T) (*api.Client, *capture) {
	t.Helper()
	cap := &capture{hits: map[string]json.RawMessage{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io_ReadAll(r)
		cap.mu.Lock()
		cap.hits[r.Method+" "+r.URL.Path] = body
		cap.mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/apiv1/projects" && r.Method == "GET":
			w.Write([]byte(`[{"id":"p1","name":"web-app","slug":"web","organizationId":"o1","organization":{"slug":"acme"},"_count":{"deployments":2,"databases":1}}]`))
		case p == "/apiv1/organizations/user":
			w.Write([]byte(`[{"id":"o1","name":"Acme","slug":"acme"}]`))
		case strings.HasSuffix(p, "/deployments") && r.Method == "GET":
			w.Write([]byte(`[{"id":"d1","name":"api","status":"running","replicas":2,"availableReplicas":2,"image":"nginx:latest"}]`))
		case strings.HasSuffix(p, "/databases") && r.Method == "GET":
			w.Write([]byte(`[{"id":"db1","name":"main","status":"ready","mode":"cnpg"}]`))
		case p == "/apiv1/deployments/d1" && r.Method == "GET":
			w.Write([]byte(`{"id":"d1","name":"api","status":"running","replicas":2,"availableReplicas":2,"image":"nginx:latest","totalCpuUsage":120,"totalMemoryUsage":104857600,"envVars":[{"key":"PORT","value":"8080"}],"ingresses":[{"host":"api.example.com"}]}`))
		case strings.HasSuffix(p, "/pods"):
			w.Write([]byte(`[{"name":"api-abc","status":"Running","ready":"1/1","restartCount":0,"nodeName":"node-1","age":"2h"}]`))
		case strings.HasSuffix(p, "/metrics"):
			w.Write([]byte(`{"data":{"cpu":[{"timestamp":1,"value":100},{"timestamp":2,"value":140}],"memory":[{"timestamp":1,"value":1000},{"timestamp":2,"value":2000}]}}`))
		case strings.HasSuffix(p, "/logs"):
			w.Write([]byte(`{"logs":"build step 1\nbuild step 2","status":"running"}`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), cap
}

func run(cmd tea.Cmd) tea.Msg {
	if cmd == nil {
		return nil
	}
	return cmd()
}

func TestProjectsScreenRenders(t *testing.T) {
	cl, _ := fakeAPI(t)
	var s screen = newProjectsScreen(cl)
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	s, _ = s.Update(run(s.Init()))
	if v := s.View(); !strings.Contains(v, "web-app") {
		t.Fatalf("projects view missing project name:\n%s", v)
	}
}

func TestProjectScreenRenders(t *testing.T) {
	cl, _ := fakeAPI(t)
	var s screen = newProjectScreen(cl, Project{ID: "p1", Name: "web-app"})
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	// project Init batches two fetches
	s, _ = s.Update(deploymentsMsg{items: mustDeps(cl)})
	s, _ = s.Update(databasesMsg{items: mustDBs(cl)})
	v := s.View()
	if !strings.Contains(v, "api") || !strings.Contains(v, "main") {
		t.Fatalf("project view missing deployment/database:\n%s", v)
	}
}

func TestDeploymentScreenTabs(t *testing.T) {
	cl, _ := fakeAPI(t)
	d := &deploymentScreen{cl: cl, id: "d1", name: "api", loading: true}
	var s screen = d
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	s, _ = s.Update(run(fetchDetail(cl, "d1")))
	s, _ = s.Update(run(fetchPods(cl, "d1")))
	s, _ = s.Update(run(fetchMetrics(cl, "d1")))
	s, _ = s.Update(run(fetchLogs(cl, "d1")))

	overview := s.View()
	if !strings.Contains(strings.ToLower(overview), "running") || !strings.Contains(overview, "2 / 2") {
		t.Fatalf("overview missing status:\n%s", overview)
	}
	if !strings.Contains(overview, "api.example.com") {
		t.Fatalf("overview missing ingress URL:\n%s", overview)
	}
	// pods are folded into the Overview board
	if !strings.Contains(overview, "api-abc") {
		t.Fatalf("overview missing pod:\n%s", overview)
	}
	// Env tab
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("2")})
	if v := s.View(); !strings.Contains(v, "PORT") {
		t.Fatalf("env tab missing var:\n%s", v)
	}
}

func TestScaleActionHitsAPI(t *testing.T) {
	cl, cap := fakeAPI(t)
	f := newScaleScreen(cl, "d1", 2)
	f.fields[0].ti.SetValue("5")
	_, cmd := f.doSubmit()
	res, ok := run(cmd).(formResult)
	if !ok || res.err != nil {
		t.Fatalf("scale submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["POST /apiv1/deployments/d1/scale"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"replicas":5`) {
		t.Fatalf("scale endpoint not hit with replicas=5, got %q", body)
	}
}

func TestEnvSaveHitsAPI(t *testing.T) {
	cl, cap := fakeAPI(t)
	e := newEnvScreen(cl, "d1", []EnvVar{{Key: "A", Value: "1"}})
	e.ta.SetValue("A=1\nB=2\n# comment\nBAD_LINE")
	_, cmd := e.submit()
	res, ok := run(cmd).(formResult)
	if !ok || res.err != nil {
		t.Fatalf("env submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["PUT /apiv1/deployments/d1/env"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"key":"A"`) || !strings.Contains(body, `"key":"B"`) || strings.Contains(body, "BAD_LINE") {
		t.Fatalf("env body wrong: %q", body)
	}
}

// Regression: the API serializes Prisma BigInt columns (memoryRequestBytes) as
// quoted strings. Decoding must not fail the whole list (YSWS-org bug).
func TestDeploymentDecodesBigIntString(t *testing.T) {
	raw := `[{"id":"d1","name":"harbor","status":"running","replicas":1,"availableReplicas":1,"image":"x","cpuRequestMilli":500,"memoryRequestBytes":"1073741824"}]`
	var deps []Deployment
	if err := json.Unmarshal([]byte(raw), &deps); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(deps) != 1 || deps[0].Name != "harbor" {
		t.Fatalf("expected 1 deployment 'harbor', got %+v", deps)
	}
	if float64(deps[0].MemoryRequestB) != 1073741824 {
		t.Fatalf("memoryRequestBytes not parsed: %v", deps[0].MemoryRequestB)
	}
}

func TestMouseClickSelectsAndOpens(t *testing.T) {
	cl, _ := fakeAPI(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":"p1","name":"alpha","slug":"alpha"},{"id":"p2","name":"beta","slug":"beta"},{"id":"p3","name":"gamma","slug":"gamma"}]`))
	}))
	defer srv.Close()
	cl2 := apiNew(srv.URL)

	var s screen = newProjectsScreen(cl2)
	s, _ = s.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	s, _ = s.Update(run(s.Init()))
	_ = s.View() // records hit geometry
	_ = cl

	// first row is at absolute Y=4; click row index 2 (gamma) at Y=6
	click := tea.MouseMsg{X: 5, Y: 6, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft}
	s, _ = s.Update(click)
	ps := s.(*projectsScreen)
	if ps.cursor != 2 {
		t.Fatalf("click should select row 2, got %d", ps.cursor)
	}
	// clicking the already-selected row opens it (push command)
	_, cmd := s.Update(click)
	if cmd == nil {
		t.Fatal("second click on selected row should open the project")
	}
	if _, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("expected a pushScreen navigation on open-click")
	}
}

func apiNew(u string) *api.Client { return api.New(u, "t") }

func TestParseEnv(t *testing.T) {
	got := parseEnv("FOO=bar\n  BAZ = qux \n#c\n\nNOVALUE=")
	if len(got) != 3 {
		t.Fatalf("want 3 vars, got %d: %+v", len(got), got)
	}
	if got[0] != (EnvVar{"FOO", "bar"}) || got[1] != (EnvVar{"BAZ", "qux"}) {
		t.Fatalf("bad parse: %+v", got)
	}
}

func mustDeps(cl *api.Client) []Deployment {
	d, _ := getList[Deployment](cl, "/projects/p1/deployments")
	return d
}
func mustDBs(cl *api.Client) []Database {
	d, _ := getList[Database](cl, "/projects/p1/databases")
	return d
}

func io_ReadAll(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, nil
	}
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 1024)
	for {
		n, err := r.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return buf, nil
}
