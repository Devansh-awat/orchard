package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/LeafdTK/leaf/cli/internal/output"
)

func runServiceCmd(t *testing.T, srv *httptest.Server, args ...string) error {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	c := serviceCmd()
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	c.SetArgs(args)
	return c.Execute()
}

func withYes(t *testing.T) {
	t.Helper()
	yesFlag = true
	t.Cleanup(func() { yesFlag = false })
}

func TestServiceListFetchesDeployment(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"dep1","services":[{"id":"svc1","name":"web","type":"external","ports":[{"id":"p1","port":80,"targetPort":8080,"protocol":"TCP"}]}]}`)
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "list", "--deployment", "dep1"); err != nil {
		t.Fatalf("service list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/dep1" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/dep1", gotMethod, gotPath)
	}
}

func TestServiceListRequiresDeployment(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request expected")
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "list"); err == nil {
		t.Fatal("expected error without --deployment")
	}
}

func TestServiceCreateBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"id":"dep1"}`)
	}))
	defer srv.Close()

	err := runServiceCmd(t, srv, "create",
		"--deployment", "dep1",
		"--name", "web",
		"--port", "80",
		"--target-port", "8080",
		"--node-port", "30080",
		"--public",
	)
	if err != nil {
		t.Fatalf("service create: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/dep1/services" {
		t.Fatalf("request = %s %s, want POST /apiv1/deployments/dep1/services", gotMethod, gotPath)
	}
	if gotBody["name"] != "web" {
		t.Errorf("name = %v, want web", gotBody["name"])
	}
	if gotBody["exposePublic"] != true {
		t.Errorf("exposePublic = %v, want true", gotBody["exposePublic"])
	}
	ports, _ := gotBody["ports"].([]any)
	if len(ports) != 1 {
		t.Fatalf("ports = %v, want one entry", gotBody["ports"])
	}
	p, _ := ports[0].(map[string]any)
	for k, want := range map[string]float64{"servicePort": 80, "containerPort": 8080, "nodePort": 30080} {
		if p[k] != want {
			t.Errorf("ports[0].%s = %v, want %v", k, p[k], want)
		}
	}
	if p["protocol"] != "TCP" {
		t.Errorf("protocol = %v, want TCP", p["protocol"])
	}
}

func TestServiceCreateDefaults(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"id":"dep1"}`)
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "create", "--deployment", "dep1", "--port", "3000"); err != nil {
		t.Fatalf("service create: %v", err)
	}
	if gotBody["name"] != "port-3000" {
		t.Errorf("name = %v, want port-3000", gotBody["name"])
	}
	if gotBody["exposePublic"] != false {
		t.Errorf("exposePublic = %v, want false", gotBody["exposePublic"])
	}
	if _, hasDomain := gotBody["domain"]; hasDomain {
		t.Errorf("domain should be omitted when the flag is unset, got %v", gotBody["domain"])
	}
	ports, _ := gotBody["ports"].([]any)
	p, _ := ports[0].(map[string]any)
	if p["containerPort"] != float64(3000) {
		t.Errorf("containerPort = %v, want 3000 (defaults to --port)", p["containerPort"])
	}
	if _, hasNodePort := p["nodePort"]; hasNodePort {
		t.Errorf("nodePort should be omitted when unset, got %v", p["nodePort"])
	}
}

func TestServiceUpdatePorts(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"id":"dep1"}`)
	}))
	defer srv.Close()

	err := runServiceCmd(t, srv, "update", "svc1", "--deployment", "dep1", "--port", "81", "--target-port", "8081")
	if err != nil {
		t.Fatalf("service update: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/deployments/dep1/services/svc1" {
		t.Fatalf("request = %s %s, want PUT /apiv1/deployments/dep1/services/svc1", gotMethod, gotPath)
	}
	ports, _ := gotBody["ports"].([]any)
	if len(ports) != 1 {
		t.Fatalf("ports = %v, want one entry", gotBody["ports"])
	}
	p, _ := ports[0].(map[string]any)
	if p["servicePort"] != float64(81) || p["containerPort"] != float64(8081) {
		t.Errorf("ports[0] = %v, want servicePort 81 / containerPort 8081", p)
	}
	if _, hasDomain := gotBody["domain"]; hasDomain {
		t.Errorf("domain should be omitted when the flag is unset, got %v", gotBody["domain"])
	}
}

func TestServiceUpdateDomainOnly(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		io.WriteString(w, `{"id":"dep1"}`)
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "update", "svc1", "--deployment", "dep1", "--domain", "app.example.com"); err != nil {
		t.Fatalf("service update: %v", err)
	}
	if gotBody["domain"] != "app.example.com" {
		t.Errorf("domain = %v, want app.example.com", gotBody["domain"])
	}
	if _, hasPorts := gotBody["ports"]; hasPorts {
		t.Errorf("ports should be omitted when no port flags set, got %v", gotBody["ports"])
	}
}

func TestServiceUpdateNothingToDo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request expected")
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "update", "svc1", "--deployment", "dep1"); err == nil {
		t.Fatal("expected error when no flags change anything")
	}
}

func TestServiceDelete(t *testing.T) {
	withYes(t)
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"dep1"}`)
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "delete", "svc1", "--deployment", "dep1"); err != nil {
		t.Fatalf("service delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/deployments/dep1/services/svc1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/deployments/dep1/services/svc1", gotMethod, gotPath)
	}
}

func TestServiceDeleteRefusesWithoutYes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request expected without confirmation")
	}))
	defer srv.Close()

	err := runServiceCmd(t, srv, "delete", "svc1", "--deployment", "dep1")
	if !errors.Is(err, output.ErrPromptRefused) {
		t.Fatalf("err = %v, want ErrPromptRefused", err)
	}
}

func TestServiceExposureSet(t *testing.T) {
	cases := []struct {
		arg  string
		want bool
	}{
		{"public", true},
		{"internal", false},
	}
	for _, tc := range cases {
		t.Run(tc.arg, func(t *testing.T) {
			var gotMethod, gotPath string
			var gotBody map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				io.WriteString(w, `{"id":"svc1"}`)
			}))
			defer srv.Close()

			if err := runServiceCmd(t, srv, "exposure", "set", "svc1", tc.arg, "--deployment", "dep1"); err != nil {
				t.Fatalf("exposure set: %v", err)
			}
			if gotMethod != http.MethodPatch || gotPath != "/apiv1/deployments/dep1/services/svc1/exposure" {
				t.Fatalf("request = %s %s, want PATCH /apiv1/deployments/dep1/services/svc1/exposure", gotMethod, gotPath)
			}
			if gotBody["exposePublic"] != tc.want {
				t.Errorf("exposePublic = %v, want %v", gotBody["exposePublic"], tc.want)
			}
		})
	}
}

func TestServiceExposureSetRejectsBadValue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("no request expected")
	}))
	defer srv.Close()

	if err := runServiceCmd(t, srv, "exposure", "set", "svc1", "sideways", "--deployment", "dep1"); err == nil {
		t.Fatal("expected error for invalid exposure value")
	}
}

func TestServicePortPublicEnableDisable(t *testing.T) {
	cases := []struct {
		sub        string
		wantMethod string
	}{
		{"enable", http.MethodPost},
		{"disable", http.MethodDelete},
	}
	for _, tc := range cases {
		t.Run(tc.sub, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				io.WriteString(w, `{"host":"node1.example.com","port":30080}`)
			}))
			defer srv.Close()

			if err := runServiceCmd(t, srv, "port", "public", tc.sub, "svc1", "p1", "--deployment", "dep1"); err != nil {
				t.Fatalf("port public %s: %v", tc.sub, err)
			}
			wantPath := "/apiv1/deployments/dep1/services/svc1/ports/p1/public"
			if gotMethod != tc.wantMethod || gotPath != wantPath {
				t.Errorf("request = %s %s, want %s %s", gotMethod, gotPath, tc.wantMethod, wantPath)
			}
		})
	}
}
