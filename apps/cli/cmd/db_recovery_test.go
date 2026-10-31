package cmd

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/exitcode"
)

type dbRecorded struct {
	method, path, query string
	body                map[string]any
}

type dbFake struct {
	t      *testing.T
	mu     sync.Mutex
	calls  []dbRecorded
	routes map[string]func(w http.ResponseWriter, r *http.Request)
}

func newDBFake(t *testing.T, routes map[string]func(w http.ResponseWriter, r *http.Request)) (*dbFake, *httptest.Server) {
	f := &dbFake{t: t, routes: routes}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := dbRecorded{method: r.Method, path: strings.TrimPrefix(r.URL.Path, "/apiv1"), query: r.URL.RawQuery}
		if r.Body != nil && r.ContentLength != 0 && r.Method != http.MethodGet {
			rec.body = dbDecodeBody(t, r)
		}
		f.mu.Lock()
		f.calls = append(f.calls, rec)
		f.mu.Unlock()
		if h, ok := routes[r.Method+" "+rec.path]; ok {
			h(w, r)
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, rec.path)
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *dbFake) find(method, path string) *dbRecorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.calls {
		if f.calls[i].method == method && f.calls[i].path == path {
			return &f.calls[i]
		}
	}
	return nil
}

func (f *dbFake) count(method, path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c.method == method && c.path == path {
			n++
		}
	}
	return n
}

func reply(body string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }
}

func runDB(t *testing.T, srvURL string, args ...string) error {
	t.Helper()
	root := dbTestRoot(t, srvURL)
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.Execute()
}

func runDBStdout(t *testing.T, srvURL string, args ...string) (string, error) {
	t.Helper()
	root := dbTestRoot(t, srvURL)
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	var err error
	out := captureStdout(t, func() { err = root.Execute() })
	return out, err
}

func fastOperationPolls(t *testing.T) {
	prev := dbOperationMinInterval
	dbOperationMinInterval = time.Millisecond
	t.Cleanup(func() { dbOperationMinInterval = prev })
}

var envRoutes = map[string]func(w http.ResponseWriter, r *http.Request){
	"GET /databases/db1":                 reply(`{"id":"db1","projectId":"p1"}`),
	"GET /projects/p1/environments":      reply(`[{"id":"e-prod","name":"production"},{"id":"e-stg","name":"staging"}]`),
	"GET /projects/slug/proj":            reply(`{"id":"p1"}`),
	"GET /database-operations/op1":       reply(`{"id":"op1","status":"succeeded","phase":"done"}`),
	"POST /databases/db1/restore":        reply(`{"id":"op1","status":"pending","phase":"queued"}`),
	"POST /databases/db1/fork":           reply(`{"id":"op1","kind":"fork","status":"pending","phase":"queued"}`),
	"POST /checkpoints/cp1/restore":      reply(`{"id":"op1","status":"pending"}`),
	"POST /deleted-databases/t1/restore": reply(`{"id":"op1","kind":"undelete","status":"pending"}`),
}

func withRoutes(extra map[string]func(w http.ResponseWriter, r *http.Request)) map[string]func(w http.ResponseWriter, r *http.Request) {
	out := map[string]func(w http.ResponseWriter, r *http.Request){}
	for k, v := range envRoutes {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func TestDbCreateEnvPgMajorReplicas(t *testing.T) {
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"POST /projects/p1/databases": reply(`{"id":"db2"}`),
	}))
	if err := runDB(t, srv.URL, "db", "create", "--project", "proj", "--env", "staging", "--name", "main", "--pg-major", "17", "--replicas", "2"); err != nil {
		t.Fatalf("db create: %v", err)
	}
	body := f.find(http.MethodPost, "/projects/p1/databases").body
	if body["environmentId"] != "e-stg" || body["pgMajor"] != float64(17) || body["replicas"] != float64(2) {
		t.Errorf("body = %v, want environmentId e-stg, pgMajor 17, replicas 2", body)
	}
}

func TestDbCreateOmitsUnsetRecoveryFields(t *testing.T) {
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"POST /projects/p1/databases": reply(`{"id":"db2"}`),
	}))
	if err := runDB(t, srv.URL, "db", "create", "--project", "proj", "--name", "main"); err != nil {
		t.Fatalf("db create: %v", err)
	}
	body := f.find(http.MethodPost, "/projects/p1/databases").body
	for _, k := range []string{"environmentId", "pgMajor", "replicas"} {
		if _, ok := body[k]; ok {
			t.Errorf("body has %s, want it omitted: %v", k, body)
		}
	}
}

func TestDbBackupRestoreCheckpointAndAt(t *testing.T) {
	f, srv := newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "backup", "restore", "db1", "--checkpoint", "cp9", "--yes"); err != nil {
		t.Fatalf("restore --checkpoint: %v", err)
	}
	if got := f.find(http.MethodPost, "/databases/db1/restore").body; got["checkpointId"] != "cp9" || got["mode"] != nil {
		t.Errorf("body = %v, want checkpointId cp9 and no mode", got)
	}

	f, srv = newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "backup", "restore", "db1", "--at", "2026-10-30T10:00:00Z", "--yes"); err != nil {
		t.Fatalf("restore --at: %v", err)
	}
	if got := f.find(http.MethodPost, "/databases/db1/restore").body; got["at"] != "2026-10-30T10:00:00Z" {
		t.Errorf("body = %v, want at", got)
	}
}

func TestDbBackupRestoreForkResolvesEnv(t *testing.T) {
	f, srv := newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "backup", "restore", "db1", "b1", "--fork", "--name", "copy", "--env", "staging"); err != nil {
		t.Fatalf("restore --fork: %v", err)
	}
	got := f.find(http.MethodPost, "/databases/db1/restore").body
	if got["mode"] != "fork" || got["name"] != "copy" || got["environmentId"] != "e-stg" || got["backupId"] != "b1" {
		t.Errorf("body = %v", got)
	}
}

func TestDbBackupRestoreUsageErrors(t *testing.T) {
	f, srv := newDBFake(t, envRoutes)
	for _, args := range [][]string{
		{"db", "backup", "restore", "db1", "b1", "--checkpoint", "cp1", "--yes"},
		{"db", "backup", "restore", "db1", "--checkpoint", "cp1", "--at", "latest", "--yes"},
		{"db", "backup", "restore", "db1", "--name", "x", "--yes"},
	} {
		err := runDB(t, srv.URL, args...)
		if code := exitcode.FromError(err); code != exitcode.Usage {
			t.Errorf("%v: exit %d (%v), want %d", args, code, err, exitcode.Usage)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("server saw %d requests, want 0", len(f.calls))
	}
}

func TestDbBackupRestoreWaitFollowsOperation(t *testing.T) {
	fastOperationPolls(t)
	polls := 0
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /database-operations/op1": func(w http.ResponseWriter, r *http.Request) {
			polls++
			if polls < 3 {
				io.WriteString(w, `{"id":"op1","status":"running","phase":"recovering"}`)
				return
			}
			io.WriteString(w, `{"id":"op1","status":"succeeded","phase":"done"}`)
		},
	}))
	if err := runDB(t, srv.URL, "db", "backup", "restore", "db1", "--yes", "--wait", "--timeout", "5s"); err != nil {
		t.Fatalf("restore --wait: %v", err)
	}
	if polls != 3 {
		t.Errorf("polls = %d, want 3", polls)
	}
	if q := f.find(http.MethodGet, "/database-operations/op1").query; q != "wait=1" {
		t.Errorf("poll query = %q, want wait=1", q)
	}
}

func TestDbOpsGetWaitFailure(t *testing.T) {
	fastOperationPolls(t)
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /database-operations/op2": reply(`{"id":"op2","kind":"restore","status":"failed","phase":"recovering","error":"no backup covers that time"}`),
	})
	err := runDB(t, srv.URL, "db", "ops", "get", "op2", "--wait", "--timeout", "5s")
	var opErr *dbOperationError
	if !errors.As(err, &opErr) || !strings.Contains(err.Error(), "no backup covers that time") {
		t.Fatalf("err = %v, want operation failure with server error", err)
	}
	if code := exitcode.FromError(err); code != exitcode.Generic {
		t.Errorf("exit %d, want %d", code, exitcode.Generic)
	}
}

func TestDbOpsGetWaitTimeout(t *testing.T) {
	fastOperationPolls(t)
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /database-operations/op3": reply(`{"id":"op3","status":"running","phase":"provisioning"}`),
	})
	err := runDB(t, srv.URL, "db", "ops", "get", "op3", "--wait", "--timeout", "50ms")
	if code := exitcode.FromError(err); code != exitcode.Deadline {
		t.Fatalf("exit %d (%v), want %d", code, err, exitcode.Deadline)
	}
}

func TestDbOpsListCancelUndo(t *testing.T) {
	f, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/operations":        reply(`[{"id":"op1","kind":"restore","status":"succeeded"}]`),
		"POST /database-operations/op1/cancel": reply(`{"id":"op1","status":"failed"}`),
		"POST /database-operations/op1/undo":   reply(`{"id":"op4","status":"pending"}`),
	})
	if err := runDB(t, srv.URL, "db", "ops", "list", "db1"); err != nil {
		t.Fatalf("ops list: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "ops", "cancel", "op1"); err != nil {
		t.Fatalf("ops cancel: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "ops", "undo", "op1"); exitcode.FromError(err) != exitcode.Usage {
		t.Fatalf("ops undo without --yes: %v, want usage error", err)
	}
	if err := runDB(t, srv.URL, "db", "ops", "undo", "op1", "--yes"); err != nil {
		t.Fatalf("ops undo: %v", err)
	}
	if f.count(http.MethodPost, "/database-operations/op1/undo") != 1 {
		t.Errorf("undo calls = %d, want 1", f.count(http.MethodPost, "/database-operations/op1/undo"))
	}
}

func TestDbForkBody(t *testing.T) {
	f, srv := newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "fork", "db1", "--at", "latest", "--name", "scratch", "--env", "e-prod"); err != nil {
		t.Fatalf("fork: %v", err)
	}
	got := f.find(http.MethodPost, "/databases/db1/fork").body
	if got["at"] != "latest" || got["name"] != "scratch" || got["environmentId"] != "e-prod" {
		t.Errorf("body = %v", got)
	}
	if err := runDB(t, srv.URL, "db", "fork", "db1", "--at", "now", "--backup", "b1"); exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("fork --at --backup: %v, want usage error", err)
	}
}

func TestDbForkDefaultsToEmptyBody(t *testing.T) {
	f, srv := newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "fork", "db1"); err != nil {
		t.Fatalf("fork: %v", err)
	}
	if got := f.find(http.MethodPost, "/databases/db1/fork").body; len(got) != 0 {
		t.Errorf("body = %v, want empty", got)
	}
	if f.find(http.MethodGet, "/databases/db1") != nil {
		t.Error("fork without --env fetched the database, want no extra call")
	}
}

func TestDbCheckpointCreateSingleAndBulk(t *testing.T) {
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"POST /databases/db1/checkpoints": reply(`{"id":"cp1","status":"pending","kind":"manual"}`),
		"POST /checkpoints":               reply(`{"groupId":"g1","checkpoints":[{"id":"cp2","databaseId":"db1"},{"id":"cp3","databaseId":"db2"}]}`),
	}))
	if err := runDB(t, srv.URL, "db", "checkpoint", "create", "db1", "--label", "before-migration"); err != nil {
		t.Fatalf("checkpoint create db1: %v", err)
	}
	if got := f.find(http.MethodPost, "/databases/db1/checkpoints").body; got["label"] != "before-migration" {
		t.Errorf("single body = %v", got)
	}
	if err := runDB(t, srv.URL, "db", "checkpoint", "create", "--project", "proj", "--env", "production"); err != nil {
		t.Fatalf("checkpoint create bulk: %v", err)
	}
	got := f.find(http.MethodPost, "/checkpoints").body
	if got["projectId"] != "p1" || got["environmentId"] != "e-prod" {
		t.Errorf("bulk body = %v", got)
	}
}

func TestDbCheckpointCreateNeedsScope(t *testing.T) {
	_, srv := newDBFake(t, envRoutes)
	if err := runDB(t, srv.URL, "db", "checkpoint", "create"); err == nil || !strings.Contains(err.Error(), "no project scope") {
		t.Fatalf("err = %v, want missing project scope", err)
	}
}

func TestDbCheckpointListRestoreRemove(t *testing.T) {
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/checkpoints":      reply(`[{"id":"cp1","kind":"ddl","status":"durable","detail":"DROP TABLE users (by app)"}]`),
		"DELETE /checkpoints/cp1":             reply(`{"id":"cp1"}`),
		"GET /checkpoints/groups/g1":          reply(`[{"id":"cp1","databaseId":"db1"}]`),
		"POST /checkpoints/groups/g1/restore": reply(`[{"id":"op1"},{"id":"op1"}]`),
	}))
	if err := runDB(t, srv.URL, "db", "checkpoint", "list", "db1"); err != nil {
		t.Fatalf("checkpoint list: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "checkpoint", "restore", "cp1"); exitcode.FromError(err) != exitcode.Usage {
		t.Fatalf("in-place restore without --yes: %v, want usage error", err)
	}
	if err := runDB(t, srv.URL, "db", "checkpoint", "restore", "cp1", "--fork", "--name", "copy", "--project", "proj", "--env", "staging"); err != nil {
		t.Fatalf("checkpoint restore --fork: %v", err)
	}
	got := f.find(http.MethodPost, "/checkpoints/cp1/restore").body
	if got["mode"] != "fork" || got["name"] != "copy" || got["environmentId"] != "e-stg" {
		t.Errorf("restore body = %v", got)
	}
	if err := runDB(t, srv.URL, "db", "checkpoint", "rm", "cp1", "--yes"); err != nil {
		t.Fatalf("checkpoint rm: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "checkpoint", "group", "g1"); err != nil {
		t.Fatalf("checkpoint group: %v", err)
	}
	fastOperationPolls(t)
	if err := runDB(t, srv.URL, "db", "checkpoint", "restore-group", "g1", "--yes", "--wait", "--timeout", "5s"); err != nil {
		t.Fatalf("checkpoint restore-group: %v", err)
	}
	if got := f.find(http.MethodPost, "/checkpoints/groups/g1/restore").body; got["mode"] != "in_place" {
		t.Errorf("group restore body = %v", got)
	}
	if n := f.count(http.MethodGet, "/database-operations/op1"); n != 2 {
		t.Errorf("group wait polled %d times, want 2", n)
	}
}

func TestDbTestBackup(t *testing.T) {
	f, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"POST /databases/db1/restore-tests": reply(`{"id":"op5","kind":"drill","status":"pending"}`),
		"GET /databases/db1/restore-tests":  reply(`[{"id":"op5","status":"succeeded","result":{"recoveryMs":42000,"verdict":{"passed":true,"tablesChecked":12}}}]`),
	})
	if err := runDB(t, srv.URL, "db", "test-backup", "run", "db1"); err != nil {
		t.Fatalf("test-backup run: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "test-backup", "list", "db1"); err != nil {
		t.Fatalf("test-backup list: %v", err)
	}
	if f.count(http.MethodPost, "/databases/db1/restore-tests") != 1 {
		t.Error("restore test was not started")
	}
}

func TestDbDiagnoseDownExits10(t *testing.T) {
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/diagnosis": reply(`{"database":{"id":"db1","name":"main","status":"error"},"verdict":"down","reasons":["no ready instance"],"instances":{"ready":0,"wanted":1},"logTail":"a\nb\n"}`),
		"GET /databases/db2/diagnosis": reply(`{"database":{"id":"db2","name":"ok"},"verdict":"healthy","reasons":[]}`),
	})
	err := runDB(t, srv.URL, "db", "diagnose", "db1")
	if code := exitcode.FromError(err); code != exitcode.DeployCrashing {
		t.Fatalf("exit %d (%v), want %d", code, err, exitcode.DeployCrashing)
	}
	if !strings.Contains(err.Error(), "no ready instance") {
		t.Errorf("err = %v, want the reason", err)
	}
	if err := runDB(t, srv.URL, "db", "diagnose", "db2"); err != nil {
		t.Fatalf("healthy diagnose: %v", err)
	}
}

func TestDbDiagnoseJSONIsFullPayload(t *testing.T) {
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/diagnosis": reply(`{"verdict":"degraded","reasons":["archiving failing"],"logTail":"x"}`),
	})
	out, err := runDBStdout(t, srv.URL, "db", "diagnose", "db1", "-o", "json")
	if err != nil {
		t.Fatalf("diagnose: %v", err)
	}
	if !strings.Contains(out, `"archiving failing"`) || !strings.Contains(out, `"logTail"`) {
		t.Errorf("stdout = %s, want the full diagnosis", out)
	}
}

func TestDbActivity(t *testing.T) {
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/activity": reply(`{"sessions":[{"pid":10,"user":"app","state":"active","transactionSeconds":3,"query":"select 1"}],"blocked":[{"pid":11,"blockedBy":[10],"seconds":2,"query":"update t"}],"maxConnections":100}`),
	})
	if err := runDB(t, srv.URL, "db", "activity", "db1"); err != nil {
		t.Fatalf("activity: %v", err)
	}
}

func TestDbProtect(t *testing.T) {
	f, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"PATCH /databases/db1/protection": reply(`{"id":"db1","deletionProtection":true,"ddlCheckpoints":false,"restoreTests":true}`),
		"GET /databases/db1":              reply(`{"id":"db1","deletionProtection":true,"ddlCheckpoints":true,"restoreTests":false}`),
	})
	if err := runDB(t, srv.URL, "db", "protect", "db1", "--deletion", "on", "--ddl-checkpoints", "off"); err != nil {
		t.Fatalf("protect: %v", err)
	}
	got := f.find(http.MethodPatch, "/databases/db1/protection").body
	if got["deletionProtection"] != true || got["ddlCheckpoints"] != false {
		t.Errorf("body = %v", got)
	}
	if _, ok := got["restoreTests"]; ok {
		t.Errorf("body = %v, want restoreTests omitted", got)
	}
	if err := runDB(t, srv.URL, "db", "protect", "db1"); err != nil {
		t.Fatalf("protect show: %v", err)
	}
	if f.count(http.MethodPatch, "/databases/db1/protection") != 1 {
		t.Error("protect with no flags sent a PATCH")
	}
	if err := runDB(t, srv.URL, "db", "protect", "db1", "--deletion", "maybe"); exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("bad on/off: %v, want usage error", err)
	}
}

func TestDbPooler(t *testing.T) {
	f, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/pooler": reply(`{"enabled":true,"config":{"poolMode":"transaction","instances":1}}`),
		"PUT /databases/db1/pooler": reply(`{"enabled":true,"config":{"poolMode":"session","instances":2}}`),
	})
	if err := runDB(t, srv.URL, "db", "pooler", "get", "db1"); err != nil {
		t.Fatalf("pooler get: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "pooler", "set", "db1", "--enabled", "on", "--mode", "session", "--instances", "2", "--pool-size", "20", "--max-client-conn", "500"); err != nil {
		t.Fatalf("pooler set: %v", err)
	}
	got := f.find(http.MethodPut, "/databases/db1/pooler").body
	if got["enabled"] != true || got["poolMode"] != "session" || got["instances"] != float64(2) || got["defaultPoolSize"] != float64(20) || got["maxClientConn"] != float64(500) {
		t.Errorf("body = %v", got)
	}
	if err := runDB(t, srv.URL, "db", "pooler", "set", "db1"); exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("pooler set without flags: %v, want usage error", err)
	}
	if err := runDB(t, srv.URL, "db", "pooler", "set", "db1", "--mode", "statement"); exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("pooler set --mode statement: %v, want usage error", err)
	}
}

func TestDbTrash(t *testing.T) {
	f, srv := newDBFake(t, withRoutes(map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /projects/p1/deleted-databases": reply(`[{"id":"t1","name":"old","recoverableUntil":"2026-11-29T00:00:00Z"},{"id":"t2","name":"gone","recoverableUntil":null}]`),
	}))
	if err := runDB(t, srv.URL, "db", "trash", "list", "--project", "proj"); err != nil {
		t.Fatalf("trash list: %v", err)
	}
	if err := runDB(t, srv.URL, "db", "trash", "restore", "t1", "--name", "old-again", "--project", "proj", "--env", "staging"); err != nil {
		t.Fatalf("trash restore: %v", err)
	}
	got := f.find(http.MethodPost, "/deleted-databases/t1/restore").body
	if got["name"] != "old-again" || got["environmentId"] != "e-stg" {
		t.Errorf("body = %v", got)
	}
}

func TestDbDeletePrintsServerMessage(t *testing.T) {
	_, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"DELETE /databases/db1": reply(`{"success":true,"message":"Database \"main\" moved to the trash for 30 days","recoverableUntil":"2026-11-29T00:00:00Z"}`),
	})
	out, err := runDBStdout(t, srv.URL, "db", "delete", "db1", "--yes", "-o", "json")
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !strings.Contains(out, "30 days") || !strings.Contains(out, "recoverableUntil") {
		t.Errorf("stdout = %s, want the delete payload", out)
	}
}

func TestDbReplicationAndUsers(t *testing.T) {
	f, srv := newDBFake(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"GET /databases/db1/replication":     reply(`{"mode":"async","instances":2}`),
		"PATCH /databases/db1/replication":   reply(`{"mode":"preferred","instances":2}`),
		"GET /databases/db1/users":           reply(`[{"name":"reader","access":"read","present":true}]`),
		"POST /databases/db1/users":          reply(`{"name":"reader","access":"read","password":"pw"}`),
		"DELETE /databases/db1/users/reader": reply(`{"name":"reader","present":false}`),
	})
	for _, args := range [][]string{
		{"db", "replication", "get", "db1"},
		{"db", "replication", "set", "db1", "--mode", "preferred"},
		{"db", "user", "list", "db1"},
		{"db", "user", "create", "db1", "reader"},
		{"db", "user", "rm", "db1", "reader", "--yes"},
	} {
		if err := runDB(t, srv.URL, args...); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	if got := f.find(http.MethodPatch, "/databases/db1/replication").body; got["mode"] != "preferred" {
		t.Errorf("replication body = %v", got)
	}
	if got := f.find(http.MethodPost, "/databases/db1/users").body; got["name"] != "reader" || got["access"] != "read" {
		t.Errorf("user body = %v", got)
	}
	if err := runDB(t, srv.URL, "db", "replication", "set", "db1", "--mode", "sync"); exitcode.FromError(err) != exitcode.Usage {
		t.Errorf("bad replication mode: %v, want usage error", err)
	}
}
