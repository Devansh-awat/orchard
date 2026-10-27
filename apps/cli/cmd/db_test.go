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

// dbTestRoot isolates config in a temp HOME and points the client at the
// given httptest server. dbCmd() is already registered by rootCmd().
func dbTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	return rootCmd()
}

func dbDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func TestDbListNoScope(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "list"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases" {
		t.Errorf("request = %s %s, want GET /apiv1/databases", gotMethod, gotPath)
	}
}

func TestDbListProjectScope(t *testing.T) {
	var listPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/projects/slug/myproj":
			io.WriteString(w, `{"id":"p1","slug":"myproj"}`)
		case "/apiv1/projects/p1/databases":
			listPath = r.URL.Path
			io.WriteString(w, `[]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "list", "--project", "myproj"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db list: %v", err)
	}
	if listPath != "/apiv1/projects/p1/databases" {
		t.Errorf("list path = %q, want /apiv1/projects/p1/databases", listPath)
	}
}

func TestDbListOrgScope(t *testing.T) {
	var gotOrgID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/organizations/slug/myorg":
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
		case "/apiv1/databases":
			gotOrgID = r.URL.Query().Get("orgId")
			io.WriteString(w, `[]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "list", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db list: %v", err)
	}
	if gotOrgID != "o1" {
		t.Errorf("orgId = %q, want o1", gotOrgID)
	}
}

func TestDbGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"id":"db1","name":"main","status":"ready"}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "get", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1", gotMethod, gotPath)
	}
}

func TestDbCreateBody(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/databases":
			gotPath = r.URL.Path
			gotBody = dbDecodeBody(t, r)
			io.WriteString(w, `{"id":"db1"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"db", "create", "--project", "proj", "--name", "main",
		"--storage", "2Gi", "--restore-from", "postgres://src",
		"--cpu", "250", "--memory", "512Mi",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("db create: %v", err)
	}
	if gotPath != "/apiv1/projects/p1/databases" {
		t.Fatalf("path = %q, want /apiv1/projects/p1/databases", gotPath)
	}
	if gotBody["name"] != "main" || gotBody["storageSize"] != "2Gi" {
		t.Errorf("name/storageSize = %v/%v", gotBody["name"], gotBody["storageSize"])
	}
	if gotBody["restoreFromUrl"] != "postgres://src" {
		t.Errorf("restoreFromUrl = %v, want postgres://src", gotBody["restoreFromUrl"])
	}
	if gotBody["cpuRequestMilli"] != float64(250) || gotBody["memoryRequestBytes"] != float64(512*1024*1024) {
		t.Errorf("cpu/memory = %v/%v", gotBody["cpuRequestMilli"], gotBody["memoryRequestBytes"])
	}
}

func TestDbCreateWaitPollsProvisioning(t *testing.T) {
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/projects/slug/proj":
			io.WriteString(w, `{"id":"p1"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/databases":
			io.WriteString(w, `{"id":"db9"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/databases/db9/provisioning":
			polls++
			io.WriteString(w, `{"databaseId":"db9","status":"ready","done":true}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"db", "create", "--project", "proj", "--name", "main",
		"--wait", "--timeout", "5s",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("db create --wait: %v", err)
	}
	if polls != 1 {
		t.Errorf("provisioning polls = %d, want 1", polls)
	}
}

func TestDbDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "delete", "db1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/databases/db1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/databases/db1", gotMethod, gotPath)
	}
}

func TestDbDeleteRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "delete", "db1"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestDbConnection(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"host":"db1.ns.svc","port":5432,"database":"app","user":"app","password":"pw","connectionString":"postgresql://app:pw@db1.ns.svc:5432/app","publicConnectionString":null}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "connection", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db connection: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1/connection" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1/connection", gotMethod, gotPath)
	}
}

func TestDbMetricsQueryParams(t *testing.T) {
	var gotPath string
	var gotQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query()
		io.WriteString(w, `{"start":1000,"end":2000,"step":500,"data":{"cpu":[{"x":1,"y":12.5}]}}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "metrics", "db1", "--start", "1000", "--end", "2000", "--step", "500"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db metrics: %v", err)
	}
	if gotPath != "/apiv1/databases/db1/metrics" {
		t.Errorf("path = %q, want /apiv1/databases/db1/metrics", gotPath)
	}
	for k, want := range map[string]string{"start": "1000", "end": "2000", "step": "500"} {
		if got := gotQuery[k]; len(got) != 1 || got[0] != want {
			t.Errorf("query %s = %v, want %q", k, got, want)
		}
	}
}

func TestDbLogsFetchesPostgresPod(t *testing.T) {
	var logQuery map[string][]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/apiv1/databases/db1":
			io.WriteString(w, `{"id":"db1","status":"ready","namespace":"ns1","pods":[{"name":"db1-pg-1"},{"name":"db1-pg-2"}]}`)
		case "/apiv1/pods/db1-pg-1/logs":
			logQuery = r.URL.Query()
			io.WriteString(w, `{"podName":"db1-pg-1","container":"postgres","logs":"LOG: ready\n"}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "logs", "db1", "--tail", "42"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db logs: %v", err)
	}
	if logQuery == nil {
		t.Fatal("pod logs endpoint was never hit")
	}
	for k, want := range map[string]string{"namespace": "ns1", "container": "postgres", "tailLines": "42"} {
		if got := logQuery[k]; len(got) != 1 || got[0] != want {
			t.Errorf("query %s = %v, want %q", k, got, want)
		}
	}
}

func TestDbLogsNoPod(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"db1","status":"provisioning"}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "logs", "db1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "no running pod") {
		t.Fatalf("want a no-pod error, got %v", err)
	}
}

func TestDbPsqlRefusesNonTTY(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "psql", "db1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "TTY") {
		t.Fatalf("want a non-TTY refusal, got %v", err)
	}
}

func TestDbBackupList(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[]`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "list", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1/backups" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1/backups", gotMethod, gotPath)
	}
}

func TestDbBackupCreateBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{"id":"b1","status":"running"}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "create", "db1", "--label", "pre-migration", "--type", "full"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup create: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/databases/db1/backups" {
		t.Errorf("request = %s %s, want POST /apiv1/databases/db1/backups", gotMethod, gotPath)
	}
	if gotBody["label"] != "pre-migration" || gotBody["type"] != "full" {
		t.Errorf("label/type = %v/%v, want pre-migration/full", gotBody["label"], gotBody["type"])
	}
}

func TestDbBackupCreateWaitPollsList(t *testing.T) {
	var polls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/apiv1/databases/db1/backups":
			io.WriteString(w, `{"id":"b1","status":"running"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/databases/db1/backups":
			polls++
			io.WriteString(w, `[{"id":"b1","status":"completed"}]`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "create", "db1", "--wait", "--timeout", "5s"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup create --wait: %v", err)
	}
	if polls != 1 {
		t.Errorf("backup list polls = %d, want 1", polls)
	}
}

func TestDbBackupRestoreLatest(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "restore", "db1", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup restore: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/databases/db1/restore" {
		t.Errorf("request = %s %s, want POST /apiv1/databases/db1/restore", gotMethod, gotPath)
	}
	if _, ok := gotBody["backupId"]; ok {
		t.Errorf("body = %v, want no backupId for latest restore", gotBody)
	}
}

func TestDbBackupRestoreSpecific(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "restore", "db1", "b2", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup restore: %v", err)
	}
	if gotBody["backupId"] != "b2" {
		t.Errorf("backupId = %v, want b2", gotBody["backupId"])
	}
}

func TestDbBackupRestoreRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup", "restore", "db1", "b2"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestDbBackupScheduleGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"cron":"0 2 * * *"}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup-schedule", "get", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup-schedule get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1/backup-schedule" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1/backup-schedule", gotMethod, gotPath)
	}
}

func TestDbBackupScheduleSetCronBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup-schedule", "set", "db1", "--cron", "0 */6 * * *"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup-schedule set: %v", err)
	}
	if gotMethod != http.MethodPut || gotPath != "/apiv1/databases/db1/backup-schedule" {
		t.Errorf("request = %s %s, want PUT /apiv1/databases/db1/backup-schedule", gotMethod, gotPath)
	}
	if gotBody["cron"] != "0 */6 * * *" {
		t.Errorf("cron = %v, want 0 */6 * * *", gotBody["cron"])
	}
}

func TestDbBackupSchedulePresets(t *testing.T) {
	for flag, want := range map[string]string{
		"--hourly": "0 * * * *",
		"--daily":  "0 2 * * *",
		"--weekly": "0 2 * * 0",
	} {
		var gotBody map[string]any
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotBody = dbDecodeBody(t, r)
			io.WriteString(w, `{}`)
		}))

		root := dbTestRoot(t, srv.URL)
		root.SetArgs([]string{"db", "backup-schedule", "set", "db1", flag})
		if err := root.Execute(); err != nil {
			t.Fatalf("db backup-schedule set %s: %v", flag, err)
		}
		if gotBody["cron"] != want {
			t.Errorf("%s cron = %v, want %q", flag, gotBody["cron"], want)
		}
		srv.Close()
	}
}

func TestDbBackupScheduleSetRequiresFlag(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup-schedule", "set", "db1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--cron") {
		t.Fatalf("want a missing-flag error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestDbBackupScheduleClear(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "backup-schedule", "clear", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db backup-schedule clear: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/databases/db1/backup-schedule" {
		t.Errorf("request = %s %s, want DELETE /apiv1/databases/db1/backup-schedule", gotMethod, gotPath)
	}
}

func TestDbExtensionList(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"extensions":[{"name":"pgcrypto","installed":true}],"sharedPreloadLibraries":[]}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "extension", "list", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db extension list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1/extensions" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1/extensions", gotMethod, gotPath)
	}
}

func TestDbExtensionInstall(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "extension", "install", "db1", "pgcrypto"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db extension install: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/databases/db1/extensions" {
		t.Errorf("request = %s %s, want POST /apiv1/databases/db1/extensions", gotMethod, gotPath)
	}
	if gotBody["name"] != "pgcrypto" {
		t.Errorf("name = %v, want pgcrypto", gotBody["name"])
	}
	if _, ok := gotBody["addToPreload"]; ok {
		t.Errorf("body = %v, want no addToPreload without --preload", gotBody)
	}
}

func TestDbExtensionInstallPreload(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "extension", "install", "db1", "pg_stat_statements", "--preload"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db extension install --preload: %v", err)
	}
	if gotBody["addToPreload"] != true {
		t.Errorf("addToPreload = %v, want true", gotBody["addToPreload"])
	}
}

func TestDbExtensionUninstall(t *testing.T) {
	var gotMethod, gotPath, gotRemove string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotRemove = r.URL.Query().Get("removeFromPreload")
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "extension", "uninstall", "db1", "pgcrypto", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db extension uninstall: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/databases/db1/extensions/pgcrypto" {
		t.Errorf("request = %s %s, want DELETE /apiv1/databases/db1/extensions/pgcrypto", gotMethod, gotPath)
	}
	if gotRemove != "" {
		t.Errorf("removeFromPreload = %q, want unset without --remove-preload", gotRemove)
	}
}

func TestDbExtensionUninstallRemovePreload(t *testing.T) {
	var gotRemove string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRemove = r.URL.Query().Get("removeFromPreload")
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "extension", "uninstall", "db1", "pg_stat_statements", "--remove-preload", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db extension uninstall --remove-preload: %v", err)
	}
	if gotRemove != "true" {
		t.Errorf("removeFromPreload = %q, want true", gotRemove)
	}
}

func TestDbSettingsGet(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"parameters":{"max_connections":"100"}}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "settings", "get", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db settings get: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/databases/db1/settings" {
		t.Errorf("request = %s %s, want GET /apiv1/databases/db1/settings", gotMethod, gotPath)
	}
}

func TestDbSettingsSetMergesExisting(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/apiv1/databases/db1/settings":
			io.WriteString(w, `{"parameters":{"max_connections":"100","work_mem":"8MB"}}`)
		case r.Method == http.MethodPatch && r.URL.Path == "/apiv1/databases/db1/settings":
			gotMethod, gotPath = r.Method, r.URL.Path
			gotBody = dbDecodeBody(t, r)
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "settings", "set", "db1", "work_mem=16MB", "max_connections="})
	if err := root.Execute(); err != nil {
		t.Fatalf("db settings set: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/databases/db1/settings" {
		t.Errorf("request = %s %s, want PATCH /apiv1/databases/db1/settings", gotMethod, gotPath)
	}
	// the PATCH replaces the whole map server-side, so untouched keys must
	// round-trip and KEY= must remove
	want := map[string]any{"work_mem": "16MB"}
	if !reflect.DeepEqual(gotBody["parameters"], want) {
		t.Errorf("parameters = %v, want %v", gotBody["parameters"], want)
	}
}

func TestDbPublicEnable(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"host":"pg.example.com","port":31234}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "public", "enable", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db public enable: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/databases/db1/public" {
		t.Errorf("request = %s %s, want POST /apiv1/databases/db1/public", gotMethod, gotPath)
	}
}

func TestDbPublicDisable(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "public", "disable", "db1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db public disable: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/databases/db1/public" {
		t.Errorf("request = %s %s, want DELETE /apiv1/databases/db1/public", gotMethod, gotPath)
	}
}

func TestDbResourcesSetBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "resources", "set", "db1", "--cpu", "500", "--memory", "1Gi"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db resources set: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/databases/db1/resources" {
		t.Errorf("request = %s %s, want PATCH /apiv1/databases/db1/resources", gotMethod, gotPath)
	}
	if gotBody["cpuRequestMilli"] != float64(500) || gotBody["memoryRequestBytes"] != float64(1<<30) {
		t.Errorf("cpu/memory = %v/%v, want 500/%d", gotBody["cpuRequestMilli"], gotBody["memoryRequestBytes"], 1<<30)
	}
}

func TestDbResourcesSetClears(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "resources", "set", "db1", "--cpu", "0"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db resources set --cpu 0: %v", err)
	}
	if v, ok := gotBody["cpuRequestMilli"]; !ok || v != nil {
		t.Errorf("cpuRequestMilli = %v (present=%v), want explicit null", v, ok)
	}
	if _, ok := gotBody["memoryRequestBytes"]; ok {
		t.Errorf("body = %v, want memory omitted when flag untouched", gotBody)
	}
}

func TestDbResourcesSetRequiresFlag(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "resources", "set", "db1"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--cpu") {
		t.Fatalf("want a missing-flag error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestDbStorageExpand(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = dbDecodeBody(t, r)
		io.WriteString(w, `{"success":true}`)
	}))
	defer srv.Close()

	root := dbTestRoot(t, srv.URL)
	root.SetArgs([]string{"db", "storage", "expand", "db1", "--size", "10Gi"})
	if err := root.Execute(); err != nil {
		t.Fatalf("db storage expand: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/databases/db1/storage" {
		t.Errorf("request = %s %s, want PATCH /apiv1/databases/db1/storage", gotMethod, gotPath)
	}
	if gotBody["storageSize"] != "10Gi" {
		t.Errorf("storageSize = %v, want 10Gi", gotBody["storageSize"])
	}
}

func TestDbParseMemory(t *testing.T) {
	for in, want := range map[string]int64{
		"512Mi":  512 << 20,
		"1Gi":    1 << 30,
		"2048Ki": 2048 << 10,
		"1Ti":    1 << 40,
		"123456": 123456,
	} {
		got, err := dbParseMemory(in)
		if err != nil || got != want {
			t.Errorf("dbParseMemory(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "abc", "-5", "0", "12Mb", "1.5Gi"} {
		if _, err := dbParseMemory(in); err == nil {
			t.Errorf("dbParseMemory(%q): want error", in)
		}
	}
}
