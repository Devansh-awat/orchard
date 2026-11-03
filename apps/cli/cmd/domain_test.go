package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"
)

type domainCall struct {
	method string
	path   string
	body   map[string]any
}

// domainTestServer records every request and replies from the routes map
// (keyed "METHOD /apiv1/path"); unknown routes get a 404.
func domainTestServer(t *testing.T, routes map[string]string) (*httptest.Server, *[]domainCall) {
	t.Helper()
	calls := &[]domainCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		*calls = append(*calls, domainCall{r.Method, r.URL.Path, body})
		res, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, res)
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func runDomain(t *testing.T, srv *httptest.Server, args ...string) error {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	// silence the JSON the commands print for non-TTY stdout
	origStdout := os.Stdout
	devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open devnull: %v", err)
	}
	os.Stdout = devnull
	t.Cleanup(func() { os.Stdout = origStdout; devnull.Close() })

	root := rootCmd()
	registered := false
	for _, c := range root.Commands() {
		if c.Name() == "domain" {
			registered = true
		}
	}
	if !registered {
		root.AddCommand(domainCmd())
	}
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(t.Context())
}

func domainCallSigs(calls []domainCall) []string {
	sigs := []string{}
	for _, c := range calls {
		sigs = append(sigs, c.method+" "+c.path)
	}
	return sigs
}

func TestDomainListByDeployment(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/deployments/dep1": `{"id":"dep1","ingresses":[{"id":"i1","host":"x.apps.example.com"}]}`,
	})
	if err := runDomain(t, srv, "domain", "list", "--deployment", "dep1"); err != nil {
		t.Fatalf("domain list: %v", err)
	}
	want := []string{"GET /apiv1/deployments/dep1"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestDomainListProjectScope(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/projects/p1": `{
			"id":"p1",
			"deployments":[{"id":"d1","ingresses":[{"id":"i1","host":"a.example.com"}]}],
			"ingresses":[{"id":"i1","host":"a.example.com"},{"id":"i2","host":"b.example.com"}]
		}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runDomain(t, srv, "domain", "list"); err != nil {
		t.Fatalf("domain list: %v", err)
	}
	// requireProject tries the slug lookup (404) before the id lookup, then
	// the list re-fetches the project for its embedded ingresses.
	want := []string{"GET /apiv1/projects/slug/p1", "GET /apiv1/projects/p1", "GET /apiv1/projects/p1"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestDomainGet(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i1": `{"id":"i1","host":"x.example.com","routes":[{"path":"/","serviceName":"web","servicePort":80}]}`,
	})
	if err := runDomain(t, srv, "domain", "get", "i1"); err != nil {
		t.Fatalf("domain get: %v", err)
	}
	want := []string{"GET /apiv1/ingresses/i1"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestDomainCreateBody(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"POST /apiv1/deployments/dep1/ingresses": `{"id":"i9","host":"foo.example.com"}`,
	})
	if err := runDomain(t, srv, "domain", "create", "--deployment", "dep1", "--host", "foo.example.com"); err != nil {
		t.Fatalf("domain create: %v", err)
	}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, []string{"POST /apiv1/deployments/dep1/ingresses"}) {
		t.Fatalf("calls = %v", got)
	}
	body := (*calls)[0].body
	if body["host"] != "foo.example.com" {
		t.Errorf("host = %v", body["host"])
	}
	if body["path"] != "/" {
		t.Errorf("path = %v, want /", body["path"])
	}
	if body["servicePort"] != float64(80) {
		t.Errorf("servicePort = %v, want 80", body["servicePort"])
	}
	if body["tlsEnabled"] != true {
		t.Errorf("tlsEnabled = %v, want true", body["tlsEnabled"])
	}
}

func TestDomainUpdateDeploymentScoped(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i1":                `{"id":"i1","host":"old.example.com","deploymentId":"d9","projectId":"p1"}`,
		"PUT /apiv1/deployments/d9/ingresses/i1": `{"id":"i1"}`,
	})
	if err := runDomain(t, srv, "domain", "update", "i1", "--host", "new.example.com", "--service-port", "8080"); err != nil {
		t.Fatalf("domain update: %v", err)
	}
	want := []string{"GET /apiv1/ingresses/i1", "PUT /apiv1/deployments/d9/ingresses/i1"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	body := (*calls)[1].body
	if body["host"] != "new.example.com" {
		t.Errorf("host = %v", body["host"])
	}
	if body["servicePort"] != float64(8080) {
		t.Errorf("servicePort = %v, want 8080", body["servicePort"])
	}
	if _, ok := body["path"]; ok {
		t.Errorf("path should be omitted when the flag is not set, got %v", body["path"])
	}
}

func TestDomainUpdateProjectScoped(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i2": `{
			"id":"i2","host":"h.example.com","projectId":"p1","tlsEnabled":true,
			"routes":[{"path":"/","serviceName":"web","servicePort":80}]
		}`,
		"PUT /apiv1/projects/p1/ingresses/i2": `{"id":"i2"}`,
	})
	if err := runDomain(t, srv, "domain", "update", "i2", "--path", "/api"); err != nil {
		t.Fatalf("domain update: %v", err)
	}
	want := []string{"GET /apiv1/ingresses/i2", "PUT /apiv1/projects/p1/ingresses/i2"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	body := (*calls)[1].body
	if body["host"] != "h.example.com" {
		t.Errorf("host = %v, want the existing host", body["host"])
	}
	if body["tlsEnabled"] != true {
		t.Errorf("tlsEnabled = %v, want true", body["tlsEnabled"])
	}
	routes, _ := body["routes"].([]any)
	if len(routes) != 1 {
		t.Fatalf("routes = %v, want the existing route echoed back", body["routes"])
	}
	r0, _ := routes[0].(map[string]any)
	if r0["path"] != "/api" || r0["serviceName"] != "web" || r0["servicePort"] != float64(80) {
		t.Errorf("route = %v", r0)
	}
}

func TestDomainUpdateNothingToDo(t *testing.T) {
	srv, calls := domainTestServer(t, nil)
	if err := runDomain(t, srv, "domain", "update", "i1"); err == nil {
		t.Fatal("expected an error when no flags are passed")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", domainCallSigs(*calls))
	}
}

func TestDomainDelete(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i1":                `{"id":"i1","host":"x.example.com","projectId":"p1"}`,
		"DELETE /apiv1/projects/p1/ingresses/i1": `{}`,
	})
	if err := runDomain(t, srv, "domain", "delete", "i1", "--yes"); err != nil {
		t.Fatalf("domain delete: %v", err)
	}
	want := []string{"GET /apiv1/ingresses/i1", "DELETE /apiv1/projects/p1/ingresses/i1"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestDomainDeleteRefusesWithoutYes(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i1": `{"id":"i1","host":"x.example.com","projectId":"p1"}`,
	})
	if err := runDomain(t, srv, "domain", "delete", "i1"); err == nil {
		t.Fatal("expected the non-TTY confirm to refuse")
	}
	for _, sig := range domainCallSigs(*calls) {
		if sig == "DELETE /apiv1/projects/p1/ingresses/i1" {
			t.Fatal("DELETE must not fire without confirmation")
		}
	}
}

func TestDomainProtectionSetBody(t *testing.T) {
	tests := []struct {
		name     string
		mode     string
		args     []string
		wantMode string
		wantPass any
	}{
		{"password", "password", []string{"--password", "hunter2"}, "password", "hunter2"},
		{"orchard-auth alias", "orchard-auth", nil, "orchard", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, calls := domainTestServer(t, map[string]string{
				"GET /apiv1/ingresses/i1":                        `{"id":"i1","host":"x.example.com","projectId":"p1"}`,
				"PUT /apiv1/projects/p1/ingresses/i1/protection": `{"protectionMode":"` + tt.wantMode + `","protectionBypassSecret":"s3cret"}`,
			})
			args := append([]string{"domain", "protection", "set", "i1", "--mode", tt.mode}, tt.args...)
			if err := runDomain(t, srv, args...); err != nil {
				t.Fatalf("protection set: %v", err)
			}
			want := []string{"GET /apiv1/ingresses/i1", "PUT /apiv1/projects/p1/ingresses/i1/protection"}
			if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
				t.Fatalf("calls = %v, want %v", got, want)
			}
			body := (*calls)[1].body
			if body["mode"] != tt.wantMode {
				t.Errorf("mode = %v, want %v", body["mode"], tt.wantMode)
			}
			if pass, ok := body["password"]; ok != (tt.wantPass != nil) || (ok && pass != tt.wantPass) {
				t.Errorf("password = %v (%v), want %v", pass, ok, tt.wantPass)
			}
		})
	}
}

func TestDomainProtectionSetRejectsBadMode(t *testing.T) {
	srv, calls := domainTestServer(t, nil)
	if err := runDomain(t, srv, "domain", "protection", "set", "i1", "--mode", "basic"); err == nil {
		t.Fatal("expected an invalid-mode error")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", domainCallSigs(*calls))
	}
}

func TestDomainProtectionGet(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/ingresses/i1":                        `{"id":"i1","projectId":"p1"}`,
		"GET /apiv1/projects/p1/ingresses/i1/protection": `{"protectionMode":"orchard","protectionBypassSecret":"s3cret"}`,
	})
	if err := runDomain(t, srv, "domain", "protection", "get", "i1"); err != nil {
		t.Fatalf("protection get: %v", err)
	}
	want := []string{"GET /apiv1/ingresses/i1", "GET /apiv1/projects/p1/ingresses/i1/protection"}
	if got := domainCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestDomainValidateDNS(t *testing.T) {
	srv, calls := domainTestServer(t, map[string]string{
		"GET /apiv1/projects/p1":                      `{"id":"p1"}`,
		"POST /apiv1/projects/ingresses/validate-dns": `{"valid":true,"message":"CNAME record is correctly configured"}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runDomain(t, srv, "domain", "validate-dns", "foo.example.com"); err != nil {
		t.Fatalf("validate-dns: %v", err)
	}
	sigs := domainCallSigs(*calls)
	if sigs[len(sigs)-1] != "POST /apiv1/projects/ingresses/validate-dns" {
		t.Fatalf("calls = %v", sigs)
	}
	body := (*calls)[len(*calls)-1].body
	if body["projectId"] != "p1" || body["domain"] != "foo.example.com" {
		t.Errorf("body = %v", body)
	}
}

func TestDomainValidateDNSInvalidExitsNonzero(t *testing.T) {
	srv, _ := domainTestServer(t, map[string]string{
		"GET /apiv1/projects/p1":                      `{"id":"p1"}`,
		"POST /apiv1/projects/ingresses/validate-dns": `{"valid":false,"message":"DNS records do not point to the configured target."}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runDomain(t, srv, "domain", "validate-dns", "foo.example.com"); err == nil {
		t.Fatal("expected an error for an invalid DNS verdict")
	}
}
