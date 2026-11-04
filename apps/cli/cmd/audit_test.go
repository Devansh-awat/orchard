package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// auditTestRoot isolates config in a temp HOME and points the client at the
// given httptest server. audit/quota/overview are added locally when root.go
// has not registered them yet (root registration is owned elsewhere).
func auditTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	registered := map[string]bool{}
	for _, c := range root.Commands() {
		registered[c.Name()] = true
	}
	if !registered["audit"] {
		root.AddCommand(auditCmd())
	}
	if !registered["quota"] {
		root.AddCommand(quotaCmd())
	}
	if !registered["overview"] {
		root.AddCommand(overviewCmd())
	}
	return root
}

func TestAuditListOrgScope(t *testing.T) {
	var gotPath, gotAction, gotLimit string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/audit-logs/organization/o1":
			gotPath = r.URL.Path
			gotAction = r.URL.Query().Get("action")
			gotLimit = r.URL.Query().Get("limit")
			io.WriteString(w, `{"entries":[
				{"id":"a1","action":"deployment.create","createdAt":"2026-07-01T00:00:00Z","targetType":"deployment","targetLabel":"web","actor":{"username":"seb"}},
				{"id":"a2","action":"deployment.delete","createdAt":"2026-07-02T00:00:00Z","actorEmail":"x@y.z"},
				{"id":"a3","action":"audit.prune","createdAt":"2026-07-03T00:00:00Z"}
			],"nextCursor":null}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"audit", "list", "--org", "myorg", "--action", "deployment.create", "--limit", "5"})
	if err := root.Execute(); err != nil {
		t.Fatalf("audit list: %v", err)
	}
	if gotPath != "/apiv1/audit-logs/organization/o1" {
		t.Errorf("path = %q, want /apiv1/audit-logs/organization/o1", gotPath)
	}
	if gotAction != "deployment.create" || gotLimit != "5" {
		t.Errorf("action/limit = %q/%q, want deployment.create/5", gotAction, gotLimit)
	}
}

func TestAuditListDeploymentScope(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/audit-logs/deployment/d1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		gotPath = r.URL.Path
		io.WriteString(w, `{"entries":[],"nextCursor":null}`)
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"audit", "list", "--deployment", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("audit list --deployment: %v", err)
	}
	if gotPath != "/apiv1/audit-logs/deployment/d1" {
		t.Errorf("path = %q, want /apiv1/audit-logs/deployment/d1", gotPath)
	}
}

func TestAuditListAllFollowsCursor(t *testing.T) {
	var cursors []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/audit-logs/organization/o1":
			c := r.URL.Query().Get("cursor")
			cursors = append(cursors, c)
			if c == "" {
				io.WriteString(w, `{"entries":[{"id":"a2","action":"x"}],"nextCursor":"a2"}`)
				return
			}
			io.WriteString(w, `{"entries":[{"id":"a1","action":"y"}],"nextCursor":null}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"audit", "list", "--org", "myorg", "--all"})
	if err := root.Execute(); err != nil {
		t.Fatalf("audit list --all: %v", err)
	}
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "a2" {
		t.Errorf("cursors = %v, want [\"\", \"a2\"]", cursors)
	}
}

func TestAuditActorAndTarget(t *testing.T) {
	actor := map[string]string{}
	for name, entry := range map[string]map[string]any{
		"seb":            {"actor": map[string]any{"username": "seb"}},
		"Ada L":          {"actor": map[string]any{"firstName": "Ada", "lastName": "L"}},
		"x@y.z":          {"actorEmail": "x@y.z"},
		"actor-fallback": {"actor": map[string]any{}, "actorEmail": "fallback@y.z"},
	} {
		actor[name] = auditActor(entry)
	}
	if actor["seb"] != "seb" || actor["Ada L"] != "Ada L" || actor["x@y.z"] != "x@y.z" {
		t.Errorf("auditActor = %v", actor)
	}
	if actor["actor-fallback"] != "fallback@y.z" {
		t.Errorf("auditActor empty-actor fallback = %q, want fallback@y.z", actor["actor-fallback"])
	}
	if got := auditTarget(map[string]any{"targetType": "deployment", "targetLabel": "web"}); got != "deployment web" {
		t.Errorf("auditTarget = %q, want %q", got, "deployment web")
	}
	if got := auditTarget(map[string]any{"targetType": "deployment", "targetId": "d1"}); got != "deployment d1" {
		t.Errorf("auditTarget = %q, want %q", got, "deployment d1")
	}
	if got := auditTarget(map[string]any{}); got != "" {
		t.Errorf("auditTarget empty = %q, want \"\"", got)
	}
}

func TestQuotaShow(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/organizations/o1/quota":
			gotPath = r.URL.Path
			io.WriteString(w, `{"org":{"id":"o1","name":"My Org","cpuLimitMilli":4000,"memoryLimitBytes":8589934592,"maxPods":20,"maxServices":null,"defaultPodCpuMilli":250,"defaultPodMemoryBytes":null},
				"usage":{"cpuMilli":1500,"memoryBytes":1610612736,"pods":3,"services":2},
				"connections":[{"id":"o2","name":"Other","slug":"other"}]}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"quota", "show", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("quota show: %v", err)
	}
	if gotPath != "/apiv1/organizations/o1/quota" {
		t.Errorf("path = %q, want /apiv1/organizations/o1/quota", gotPath)
	}
}

func TestQuotaSubcommandPaths(t *testing.T) {
	responses := map[string]string{
		"/apiv1/organizations/o1/quota/me":       `{"allowance":{"cpuMilli":null,"memoryBytes":null,"source":{"cpu":"unlimited","memory":"unlimited"}},"usage":{"cpuMilli":100,"memoryBytes":1048576,"breakdown":[{"kind":"deployment","name":"web","projectName":"proj","cpuMilli":100,"memoryBytes":1048576,"replicas":1}]},"orgCap":{"cpuLimitMilli":null,"memoryLimitBytes":null},"effectiveLimit":{"cpuMilli":null,"memoryBytes":null}}`,
		"/apiv1/organizations/o1/quota/members":  `{"org":{"cpuLimitMilli":4000,"memoryLimitBytes":null,"defaultMemberCpuMilli":500,"defaultMemberMemoryBytes":null},"commitment":{"cpuMilli":1000,"memoryBytes":0},"members":[{"user":{"username":"seb"},"role":"owner","allowance":{"cpuMilli":null,"memoryBytes":null},"usage":{"cpuMilli":100,"memoryBytes":0}}]}`,
		"/apiv1/organizations/o1/quota/projects": `{"orgTotal":{"cpuMilli":1500,"memoryBytes":0,"pods":3,"services":2},"projects":[{"id":"p1","name":"proj","cpuLimitMilli":null,"memoryLimitBytes":null,"maxPods":null,"usage":{"cpuMilli":100,"memoryBytes":0,"pods":1}}]}`,
	}
	for sub, wantPath := range map[string]string{
		"me":       "/apiv1/organizations/o1/quota/me",
		"members":  "/apiv1/organizations/o1/quota/members",
		"projects": "/apiv1/organizations/o1/quota/projects",
	} {
		var gotPath string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/apiv1/organizations/slug/myorg" {
				io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
				return
			}
			body, ok := responses[r.URL.Path]
			if !ok {
				t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				w.WriteHeader(404)
				return
			}
			gotPath = r.URL.Path
			io.WriteString(w, body)
		}))

		root := auditTestRoot(t, srv.URL)
		root.SetArgs([]string{"quota", sub, "--org", "myorg"})
		if err := root.Execute(); err != nil {
			t.Fatalf("quota %s: %v", sub, err)
		}
		if gotPath != wantPath {
			t.Errorf("quota %s path = %q, want %q", sub, gotPath, wantPath)
		}
		srv.Close()
	}
}

func TestQuotaFormatting(t *testing.T) {
	if got := quotaCPU(nil); got != "unlimited" {
		t.Errorf("quotaCPU(nil) = %q, want unlimited", got)
	}
	if got := quotaCPU(float64(250)); got != "250m" {
		t.Errorf("quotaCPU(250) = %q, want 250m", got)
	}
	if got := quotaMem(nil); got != "unlimited" {
		t.Errorf("quotaMem(nil) = %q, want unlimited", got)
	}
	for in, want := range map[float64]string{
		0:             "0B",
		512:           "512B",
		2048:          "2Ki",
		1048576:       "1Mi",
		1610612736:    "1.5Gi",
		8589934592:    "8Gi",
		2199023255552: "2Ti",
	} {
		if got := quotaHumanBytes(in); got != want {
			t.Errorf("quotaHumanBytes(%v) = %q, want %q", in, got, want)
		}
	}
	if got := quotaCount(nil); got != "unlimited" {
		t.Errorf("quotaCount(nil) = %q, want unlimited", got)
	}
	if got := quotaCount(float64(20)); got != "20" {
		t.Errorf("quotaCount(20) = %q, want 20", got)
	}
}

const overviewTestBody = `{"organization":{"id":"o1","slug":"myorg","name":"My Org"},
	"projects":[{"id":"p1","name":"proj"}],
	"deployments":[{"id":"d1","name":"web","status":"running","project":{"name":"proj"},"ingresses":[{"host":"web.example.com"}]}],
	"databases":[],
	"currentMember":{"role":"owner","synthetic":false}}`

func TestOverviewFetchesBySlug(t *testing.T) {
	var gotPath string
	var buildsHits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/overview/orgs/myorg":
			gotPath = r.URL.Path
			io.WriteString(w, overviewTestBody)
		case "/apiv1/overview/orgs/myorg/builds":
			buildsHits++
			io.WriteString(w, `{"active":[],"recent":[]}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"overview", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("overview: %v", err)
	}
	if gotPath != "/apiv1/overview/orgs/myorg" {
		t.Errorf("path = %q, want /apiv1/overview/orgs/myorg", gotPath)
	}
	if buildsHits != 0 {
		t.Errorf("builds endpoint hit %d times without --builds, want 0", buildsHits)
	}
}

func TestOverviewResolvesSlugFromID(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/o1":
			w.WriteHeader(404)
		case "/apiv1/organizations/o1":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/overview/orgs/myorg":
			gotPath = r.URL.Path
			io.WriteString(w, overviewTestBody)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"overview", "--org", "o1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("overview --org <id>: %v", err)
	}
	if gotPath != "/apiv1/overview/orgs/myorg" {
		t.Errorf("path = %q, want the SLUG route /apiv1/overview/orgs/myorg", gotPath)
	}
}

func TestOverviewBuilds(t *testing.T) {
	var gotBuildsPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/overview/orgs/myorg":
			io.WriteString(w, overviewTestBody)
		case "/apiv1/overview/orgs/myorg/builds":
			gotBuildsPath = r.URL.Path
			io.WriteString(w, `{"active":[{"id":"d1","name":"web","buildStatus":"building","buildStep":"docker","project":{"name":"proj"}}],
				"recent":[{"id":"h1","commitSha":"abcdef1234567","branch":"main","triggerType":"push","isActive":true,"createdAt":"2026-07-01T00:00:00Z","deployment":{"name":"web","buildStatus":"succeeded","project":{"name":"proj"}}}]}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"overview", "--org", "myorg", "--builds"})
	if err := root.Execute(); err != nil {
		t.Fatalf("overview --builds: %v", err)
	}
	if gotBuildsPath != "/apiv1/overview/orgs/myorg/builds" {
		t.Errorf("builds path = %q, want /apiv1/overview/orgs/myorg/builds", gotBuildsPath)
	}
}

func TestOverviewRequiresOrg(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := auditTestRoot(t, srv.URL)
	root.SetArgs([]string{"overview"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "no organization scope") {
		t.Fatalf("want a no-org-scope error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}
