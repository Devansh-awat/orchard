package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type templateCall struct {
	method string
	path   string
	body   map[string]any
}

// templateTestServer records every request and replies from the routes map
// (keyed "METHOD /apiv1/path"); unknown routes get a 404.
func templateTestServer(t *testing.T, routes map[string]string) (*httptest.Server, *[]templateCall) {
	t.Helper()
	calls := &[]templateCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		*calls = append(*calls, templateCall{r.Method, r.URL.Path, body})
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

func runTemplate(t *testing.T, srv *httptest.Server, args ...string) error {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

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
		if c.Name() == "template" {
			registered = true
		}
	}
	if !registered {
		root.AddCommand(templateCmd())
	}
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(t.Context())
}

func templateCallSigs(calls []templateCall) []string {
	sigs := []string{}
	for _, c := range calls {
		sigs = append(sigs, c.method+" "+c.path)
	}
	return sigs
}

func templateWriteYAML(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "template.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write yaml: %v", err)
	}
	return path
}

func TestTemplateList(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/templates": `[{"id":"t1","name":"wordpress","displayName":"WordPress","version":"1.0.0","category":"cms","isBuiltIn":true}]`,
	})
	if err := runTemplate(t, srv, "template", "list"); err != nil {
		t.Fatalf("template list: %v", err)
	}
	want := []string{"GET /apiv1/templates"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestTemplateGet(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/templates/t1": `{
			"id":"t1","name":"wordpress","displayName":"WordPress","tags":["cms","php"],
			"parameters":[{"name":"appName","type":"string","required":true,"default":"blog"}],
			"resources":[{"name":"db","type":"database"},{"name":"web","type":"deployment"}]
		}`,
	})
	if err := runTemplate(t, srv, "template", "get", "t1"); err != nil {
		t.Fatalf("template get: %v", err)
	}
	want := []string{"GET /apiv1/templates/t1"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestTemplateDeployBody(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/projects/p1":                     `{"id":"p1"}`,
		"POST /apiv1/projects/p1/template-instances": `{"id":"i1","status":"active"}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	err := runTemplate(t, srv,
		"template", "deploy", "t1",
		"--param", "appName=blog", "--param", "dbPassword=s3cret",
		"--cpu", "250", "--memory", "512Mi",
	)
	if err != nil {
		t.Fatalf("template deploy: %v", err)
	}
	// requireProject tries the slug lookup (404) before the id lookup.
	want := []string{"GET /apiv1/projects/slug/p1", "GET /apiv1/projects/p1", "POST /apiv1/projects/p1/template-instances"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	body := (*calls)[2].body
	if body["templateId"] != "t1" {
		t.Errorf("templateId = %v", body["templateId"])
	}
	params, _ := body["parameters"].(map[string]any)
	if params["appName"] != "blog" || params["dbPassword"] != "s3cret" {
		t.Errorf("parameters = %v", body["parameters"])
	}
	if body["cpuRequestMilli"] != float64(250) {
		t.Errorf("cpuRequestMilli = %v, want 250", body["cpuRequestMilli"])
	}
	if body["memoryRequestBytes"] != float64(512<<20) {
		t.Errorf("memoryRequestBytes = %v, want %d", body["memoryRequestBytes"], 512<<20)
	}
}

func TestTemplateDeployDefaultsBody(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/projects/p1":                     `{"id":"p1"}`,
		"POST /apiv1/projects/p1/template-instances": `{"id":"i1","status":"active"}`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runTemplate(t, srv, "template", "deploy", "t1"); err != nil {
		t.Fatalf("template deploy: %v", err)
	}
	body := (*calls)[len(*calls)-1].body
	params, ok := body["parameters"].(map[string]any)
	if !ok || len(params) != 0 {
		t.Errorf("parameters = %v, want an empty map (server rejects a missing key)", body["parameters"])
	}
	if _, ok := body["cpuRequestMilli"]; ok {
		t.Errorf("cpuRequestMilli should be omitted when the flag is not set, got %v", body["cpuRequestMilli"])
	}
	if _, ok := body["memoryRequestBytes"]; ok {
		t.Errorf("memoryRequestBytes should be omitted when the flag is not set, got %v", body["memoryRequestBytes"])
	}
}

func TestTemplateDeployRequiresProject(t *testing.T) {
	srv, calls := templateTestServer(t, nil)
	if err := runTemplate(t, srv, "template", "deploy", "t1"); err == nil {
		t.Fatal("expected an error without a project scope")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", templateCallSigs(*calls))
	}
}

func TestTemplateDeployRejectsBadParam(t *testing.T) {
	srv, calls := templateTestServer(t, nil)
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runTemplate(t, srv, "template", "deploy", "t1", "--param", "noequals"); err == nil {
		t.Fatal("expected an error for a malformed --param")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", templateCallSigs(*calls))
	}
}

func TestTemplateInstanceList(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1"}`,
		"GET /apiv1/projects/p1/template-instances": `[{
			"id":"i1","name":"blog","status":"active","createdAt":"2026-07-01",
			"template":{"displayName":"WordPress"},
			"deployments":[{"id":"d1"}],"databases":[{"id":"db1"}],"ingresses":[]
		}]`,
	})
	t.Setenv("ORCHARD_PROJECT", "p1")
	if err := runTemplate(t, srv, "template", "instance", "list"); err != nil {
		t.Fatalf("template instance list: %v", err)
	}
	sigs := templateCallSigs(*calls)
	if sigs[len(sigs)-1] != "GET /apiv1/projects/p1/template-instances" {
		t.Errorf("calls = %v", sigs)
	}
}

func TestTemplateInstanceGet(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"GET /apiv1/template-instances/i1": `{
			"id":"i1","name":"blog","status":"active","projectId":"p1",
			"template":{"displayName":"WordPress"},
			"deployments":[{"id":"d1","name":"web","status":"running","image":"wordpress:6"}],
			"databases":[{"id":"db1","name":"blog-db","status":"running","dbName":"wordpress"}],
			"ingresses":[{"id":"ing1","name":"blog","host":"blog.example.com","path":"/"}]
		}`,
	})
	if err := runTemplate(t, srv, "template", "instance", "get", "i1"); err != nil {
		t.Fatalf("template instance get: %v", err)
	}
	want := []string{"GET /apiv1/template-instances/i1"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestTemplateInstanceDelete(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"DELETE /apiv1/template-instances/i1": `{"success":true,"errors":[]}`,
	})
	if err := runTemplate(t, srv, "template", "instance", "delete", "i1", "--yes"); err != nil {
		t.Fatalf("template instance delete: %v", err)
	}
	want := []string{"DELETE /apiv1/template-instances/i1"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestTemplateInstanceDeleteRefusesWithoutYes(t *testing.T) {
	srv, calls := templateTestServer(t, nil)
	if err := runTemplate(t, srv, "template", "instance", "delete", "i1"); err == nil {
		t.Fatal("expected the non-TTY confirm to refuse")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", templateCallSigs(*calls))
	}
}

func TestTemplateAdminCreate(t *testing.T) {
	yaml := "apiVersion: leaf/v1\nmetadata:\n  name: custom\n"
	path := templateWriteYAML(t, yaml)
	srv, calls := templateTestServer(t, map[string]string{
		"POST /apiv1/templates": `{"id":"t9","name":"custom"}`,
	})
	if err := runTemplate(t, srv, "template", "admin", "create", "--file", path); err != nil {
		t.Fatalf("template admin create: %v", err)
	}
	want := []string{"POST /apiv1/templates"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if (*calls)[0].body["yaml"] != yaml {
		t.Errorf("yaml = %q, want the raw file content", (*calls)[0].body["yaml"])
	}
}

func TestTemplateAdminUpdate(t *testing.T) {
	yaml := "apiVersion: leaf/v1\nmetadata:\n  name: custom\n"
	path := templateWriteYAML(t, yaml)
	srv, calls := templateTestServer(t, map[string]string{
		"PUT /apiv1/templates/t9": `{"id":"t9","name":"custom"}`,
	})
	if err := runTemplate(t, srv, "template", "admin", "update", "t9", "--file", path); err != nil {
		t.Fatalf("template admin update: %v", err)
	}
	want := []string{"PUT /apiv1/templates/t9"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if (*calls)[0].body["yaml"] != yaml {
		t.Errorf("yaml = %q, want the raw file content", (*calls)[0].body["yaml"])
	}
}

func TestTemplateAdminDelete(t *testing.T) {
	srv, calls := templateTestServer(t, map[string]string{
		"DELETE /apiv1/templates/t9": `{"success":true}`,
	})
	if err := runTemplate(t, srv, "template", "admin", "delete", "t9", "--yes"); err != nil {
		t.Fatalf("template admin delete: %v", err)
	}
	want := []string{"DELETE /apiv1/templates/t9"}
	if got := templateCallSigs(*calls); !reflect.DeepEqual(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
}

func TestTemplateAdminDeleteRefusesWithoutYes(t *testing.T) {
	srv, calls := templateTestServer(t, nil)
	if err := runTemplate(t, srv, "template", "admin", "delete", "t9"); err == nil {
		t.Fatal("expected the non-TTY confirm to refuse")
	}
	if len(*calls) != 0 {
		t.Errorf("no requests expected, got %v", templateCallSigs(*calls))
	}
}
