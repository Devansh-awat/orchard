package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// deployTestRoot isolates config in a temp HOME and points the client at the
// given httptest server. deployCmd() is already registered by rootCmd().
func deployTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	return rootCmd()
}

func deployDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func TestDeployListNoScope(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "list"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments", gotMethod, gotPath)
	}
}

func TestDeployListProjectScope(t *testing.T) {
	var listPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects/slug/myproj":
			io.WriteString(w, `{"id":"p1","slug":"myproj"}`)
		case "/apiv1/projects/p1/deployments":
			listPath = r.URL.Path
			io.WriteString(w, `[]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "list", "--project", "myproj"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy list: %v", err)
	}
	if listPath != "/apiv1/projects/p1/deployments" {
		t.Errorf("list path = %q, want /apiv1/projects/p1/deployments", listPath)
	}
}

func TestDeployGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"d1","name":"web","status":"running"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "get", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/d1" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/d1", gotMethod, gotPath)
	}
}

func TestDeployCreateImageBody(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/deployments":
			gotPath = r.URL.Path
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{"id":"d1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"deploy", "create", "--project", "proj", "--name", "web",
		"--image", "nginx:latest", "--port", "8080",
		"--env", "FOO=bar", "--cpu", "250", "--memory", "512Mi",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy create: %v", err)
	}
	if gotPath != "/apiv1/projects/p1/deployments" {
		t.Fatalf("path = %q, want /apiv1/projects/p1/deployments", gotPath)
	}
	if gotBody["name"] != "web" || gotBody["image"] != "nginx:latest" {
		t.Errorf("name/image = %v/%v", gotBody["name"], gotBody["image"])
	}
	if gotBody["port"] != float64(8080) || gotBody["cpuRequestMilli"] != float64(250) {
		t.Errorf("port/cpu = %v/%v", gotBody["port"], gotBody["cpuRequestMilli"])
	}
	if gotBody["memoryRequestBytes"] != float64(512*1024*1024) {
		t.Errorf("memoryRequestBytes = %v, want %v", gotBody["memoryRequestBytes"], 512*1024*1024)
	}
	env, _ := gotBody["env"].([]any)
	if len(env) != 1 || !reflect.DeepEqual(env[0], map[string]any{"key": "FOO", "value": "bar"}) {
		t.Errorf("env = %v, want [{FOO bar}]", gotBody["env"])
	}
}

func TestDeployCreateGithubBody(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/deployments/from-github":
			gotPath = r.URL.Path
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{"id":"d1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"deploy", "create", "--project", "proj", "--name", "app",
		"--github", "leafd/app#dev", "--railpack", "--build-root",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy create: %v", err)
	}
	if gotPath != "/apiv1/projects/p1/deployments/from-github" {
		t.Fatalf("path = %q, want the from-github route", gotPath)
	}
	if gotBody["githubRepo"] != "leafd/app" || gotBody["branch"] != "dev" {
		t.Errorf("repo/branch = %v/%v, want leafd/app dev", gotBody["githubRepo"], gotBody["branch"])
	}
	if gotBody["buildType"] != "railpack" || gotBody["buildFromRoot"] != true {
		t.Errorf("buildType/buildFromRoot = %v/%v", gotBody["buildType"], gotBody["buildFromRoot"])
	}
}

func TestDeployCreateRequiresImageXorGithub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer srv.Close()

	for _, args := range [][]string{
		{"deploy", "create", "--name", "x"},
		{"deploy", "create", "--name", "x", "--image", "nginx", "--github", "a/b"},
	} {
		root := deployTestRoot(t, srv.URL)
		root.SetArgs(args)
		err := root.Execute()
		if err == nil || !strings.Contains(err.Error(), "exactly one") {
			t.Errorf("args %v: want image-xor-github error, got %v", args, err)
		}
	}
}

func TestDeployDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "delete", "d1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/deployments/d1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/deployments/d1", gotMethod, gotPath)
	}
}

func TestDeployDeleteRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "delete", "d1"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestDeployCancel(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "cancel", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy cancel: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/d1/cancel" {
		t.Errorf("request = %s %s, want POST /apiv1/deployments/d1/cancel", gotMethod, gotPath)
	}
}

func TestDeployRollback(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "rollback", "d1", "h1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy rollback: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/d1/rollback/h1" {
		t.Errorf("request = %s %s, want POST /apiv1/deployments/d1/rollback/h1", gotMethod, gotPath)
	}
}

func TestDeployImageSet(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "image", "set", "d1", "nginx:1.27"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy image set: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/deployments/d1/image" {
		t.Errorf("request = %s %s, want PATCH /apiv1/deployments/d1/image", gotMethod, gotPath)
	}
	if gotBody["image"] != "nginx:1.27" {
		t.Errorf("body image = %v, want nginx:1.27", gotBody["image"])
	}
}

func TestDeployHistory(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "history", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy history: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/image-history" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/image-history", gotPath)
	}
}

func TestDeployHistoryLogs(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"logs":"step 1\n"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "history", "d1", "--logs", "h1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy history --logs: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/image-history/h1/logs" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/image-history/h1/logs", gotPath)
	}
}

func TestDeployEnvGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"d1","envVars":[{"key":"A","value":"1","secret":false}]}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "env", "get", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy env get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/d1" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/d1", gotMethod, gotPath)
	}
}

func TestDeployEnvSetMergesExisting(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","envVars":[{"key":"OLD","value":"1","secret":true}]}`)
		case r.Method == http.MethodPut && r.URL.Path == "/apiv1/deployments/d1/env":
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "env", "set", "d1", "NEW=2"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy env set: %v", err)
	}
	want := []any{
		map[string]any{"key": "OLD", "value": "1", "secret": true},
		map[string]any{"key": "NEW", "value": "2", "secret": false},
	}
	if !reflect.DeepEqual(gotBody["env"], want) {
		t.Errorf("env body = %v, want %v", gotBody["env"], want)
	}
}

func TestDeployEnvUnset(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","envVars":[{"key":"A","value":"1"},{"key":"B","value":"2","secret":true}]}`)
		case r.Method == http.MethodPut && r.URL.Path == "/apiv1/deployments/d1/env":
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "env", "unset", "d1", "A"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy env unset: %v", err)
	}
	want := []any{map[string]any{"key": "B", "value": "2", "secret": true}}
	if !reflect.DeepEqual(gotBody["env"], want) {
		t.Errorf("env body = %v, want %v", gotBody["env"], want)
	}
}

func TestDeployResourcesSetPreservesUntouched(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","cpuRequestMilli":100,"memoryRequestBytes":123456}`)
		case r.Method == http.MethodPatch && r.URL.Path == "/apiv1/deployments/d1/resources":
			gotMethod, gotPath = r.Method, r.URL.Path
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "resources", "set", "d1", "--cpu", "500"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy resources set: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/deployments/d1/resources" {
		t.Errorf("request = %s %s, want PATCH /apiv1/deployments/d1/resources", gotMethod, gotPath)
	}
	// the PATCH clears omitted fields server-side, so memory must round-trip
	if gotBody["cpuRequestMilli"] != float64(500) || gotBody["memoryRequestBytes"] != float64(123456) {
		t.Errorf("body = %v, want cpu 500 + memory 123456 preserved", gotBody)
	}
}

func TestDeployVolumesSetBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "volumes", "set", "d1", "--volume", "/data=5Gi"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy volumes set: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/deployments/d1/volumes" {
		t.Errorf("request = %s %s, want PUT /apiv1/deployments/d1/volumes", gotMethod, gotPath)
	}
	want := []any{map[string]any{
		"name": "data", "type": "pvc", "mountPath": "/data", "pvcName": "data", "storageSize": "5Gi",
	}}
	if !reflect.DeepEqual(gotBody["volumes"], want) {
		t.Errorf("volumes body = %v, want %v", gotBody["volumes"], want)
	}
}

func TestDeployStrategySet(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "strategy", "set", "d1", "--type", "rollingupdate"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy strategy set: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/deployments/d1/strategy" {
		t.Errorf("request = %s %s, want PATCH /apiv1/deployments/d1/strategy", gotMethod, gotPath)
	}
	if gotBody["strategy"] != "rollingUpdate" {
		t.Errorf("strategy = %v, want rollingUpdate", gotBody["strategy"])
	}
}

func TestDeployHealthCheckSetMerges(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","healthCheckEnabled":false,"healthCheckInterval":10}`)
		case r.Method == http.MethodPut && r.URL.Path == "/apiv1/deployments/d1/health-check":
			gotBody = deployDecodeBody(t, r)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"deploy", "health-check", "set", "d1",
		"--enabled", "--type", "http", "--path", "/healthz", "--port", "8080",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy health-check set: %v", err)
	}
	if gotBody["healthCheckEnabled"] != true || gotBody["healthCheckType"] != "http" {
		t.Errorf("enabled/type = %v/%v", gotBody["healthCheckEnabled"], gotBody["healthCheckType"])
	}
	if gotBody["healthCheckPath"] != "/healthz" || gotBody["healthCheckPort"] != float64(8080) {
		t.Errorf("path/port = %v/%v", gotBody["healthCheckPath"], gotBody["healthCheckPort"])
	}
	// untouched values come from the deployment (interval) or schema defaults
	if gotBody["healthCheckInterval"] != float64(10) || gotBody["healthCheckTimeout"] != float64(5) {
		t.Errorf("interval/timeout = %v/%v, want 10/5", gotBody["healthCheckInterval"], gotBody["healthCheckTimeout"])
	}
}

func TestDeployBuildRootSet(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "build-root", "set", "d1", "on"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy build-root set: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/deployments/d1/build-config" {
		t.Errorf("request = %s %s, want PUT /apiv1/deployments/d1/build-config", gotMethod, gotPath)
	}
	if gotBody["buildFromRoot"] != true {
		t.Errorf("buildFromRoot = %v, want true", gotBody["buildFromRoot"])
	}
}

func TestDeployPods(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `[{"name":"web-1","status":"Running"}]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "pods", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy pods: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/pods" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/pods", gotPath)
	}
}

func TestDeployPodsLive(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"pods":[],"warnings":[]}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "pods", "d1", "--live"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy pods --live: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/pods-live" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/pods-live", gotPath)
	}
}

func TestDeployMetrics(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"start":1,"end":2,"step":3,"data":{"cpu":[{"x":1,"y":12.5}]}}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "metrics", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy metrics: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/metrics" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/metrics", gotPath)
	}
}

func TestDeployLogsBuild(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"logs":"step 1\n"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "logs", "d1", "--build"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy logs --build: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/logs" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/logs", gotPath)
	}
}

func TestDeployLogsRuntimeAggregatesPods(t *testing.T) {
	var logQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/deployments/d1":
			io.WriteString(w, `{"id":"d1","namespace":"ns1"}`)
		case "/apiv1/deployments/d1/pods":
			io.WriteString(w, `[{"name":"web-1"}]`)
		case "/apiv1/pods/web-1/logs":
			logQuery = r.URL.Query()
			io.WriteString(w, `{"podName":"web-1","container":"web","logs":"hello\n"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "logs", "d1", "--tail", "42"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy logs: %v", err)
	}
	if logQuery == nil {
		t.Fatal("pod logs endpoint was never hit")
	}
	for k, want := range map[string]string{"namespace": "ns1", "tailLines": "42"} {
		if got := logQuery[k]; len(got) != 1 || got[0] != want {
			t.Errorf("query %s = %v, want %q", k, got, want)
		}
	}
}

func TestDeployKilledList(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "killed", "list", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy killed list: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/killed-containers" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/killed-containers", gotPath)
	}
}

func TestDeployKilledLogs(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		io.WriteString(w, `{"logs":"boom\n"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "killed", "logs", "d1", "e1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy killed logs: %v", err)
	}
	if gotPath != "/apiv1/deployments/d1/killed-containers/e1/logs" {
		t.Errorf("path = %q, want /apiv1/deployments/d1/killed-containers/e1/logs", gotPath)
	}
}

func TestDeployAutoDeployStatus(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"enabled":true,"branch":"main"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "auto-deploy", "status", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy auto-deploy status: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/d1/auto-deploy" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/d1/auto-deploy", gotMethod, gotPath)
	}
}

func TestDeployAutoDeployEnable(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "auto-deploy", "enable", "d1", "--branch", "main"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy auto-deploy enable: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/d1/auto-deploy/enable" {
		t.Errorf("request = %s %s, want POST .../auto-deploy/enable", gotMethod, gotPath)
	}
	if gotBody["branch"] != "main" {
		t.Errorf("branch = %v, want main", gotBody["branch"])
	}
}

func TestDeployAutoDeployDisable(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "auto-deploy", "disable", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy auto-deploy disable: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/d1/auto-deploy/disable" {
		t.Errorf("request = %s %s, want POST .../auto-deploy/disable", gotMethod, gotPath)
	}
}

func TestDeployWebhookTokenList(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "webhook-token", "list", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy webhook-token list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/d1/webhook-tokens" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/d1/webhook-tokens", gotMethod, gotPath)
	}
}

func TestDeployWebhookTokenCreate(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = deployDecodeBody(t, r)
		io.WriteString(w, `{"id":"t1","token":"secret123","label":"ci"}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "webhook-token", "create", "d1", "--label", "ci"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy webhook-token create: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/deployments/d1/webhook-tokens" {
		t.Errorf("request = %s %s, want POST /apiv1/deployments/d1/webhook-tokens", gotMethod, gotPath)
	}
	if gotBody["label"] != "ci" {
		t.Errorf("label = %v, want ci", gotBody["label"])
	}
}

func TestDeployWebhookTokenDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "webhook-token", "delete", "d1", "t1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy webhook-token delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/deployments/d1/webhook-tokens/t1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/deployments/d1/webhook-tokens/t1", gotMethod, gotPath)
	}
}

func TestDeployGithubDeployments(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "github-deployments", "d1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy github-deployments: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/deployments/d1/github-deployments" {
		t.Errorf("request = %s %s, want GET /apiv1/deployments/d1/github-deployments", gotMethod, gotPath)
	}
}

func TestDeployRebuildWaitPollsBuildStatus(t *testing.T) {
	var rebuilt bool
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/deployments/d1/rebuild":
			rebuilt = true
			io.WriteString(w, `{}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/deployments/d1":
			polls++
			io.WriteString(w, `{"id":"d1","buildStatus":"succeeded"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := deployTestRoot(t, srv.URL)
	root.SetArgs([]string{"deploy", "rebuild", "d1", "--wait", "--timeout", "5s"})
	if err := root.Execute(); err != nil {
		t.Fatalf("deploy rebuild --wait: %v", err)
	}
	if !rebuilt {
		t.Error("rebuild endpoint was never hit")
	}
	if polls != 1 {
		t.Errorf("status polls = %d, want 1", polls)
	}
}
