package cmd

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

// seen records every request the fake API receives, so tests can assert on
// method + path (+ body) exactly as the real server would see them.
type seenReq struct {
	Method string
	Path   string
	Query  string
	Body   []byte
}

type recorder struct {
	mu   sync.Mutex
	reqs []seenReq
}

func (rec *recorder) add(r *http.Request, body []byte) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.reqs = append(rec.reqs, seenReq{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: body})
}

func (rec *recorder) find(method, path string) (seenReq, bool) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, r := range rec.reqs {
		if r.Method == method && r.Path == path {
			return r, true
		}
	}
	return seenReq{}, false
}

// startProjectAPI serves the routes projects commands touch: slug resolution
// falls through to id lookup, and everything else is looked up in routes
// keyed by "METHOD /path".
func startProjectAPI(t *testing.T, routes map[string]string) *recorder {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.add(r, body)
		if res, ok := routes[r.Method+" "+r.URL.Path]; ok {
			io.WriteString(w, res)
			return
		}
		w.WriteHeader(404)
		io.WriteString(w, `{"message":"not found"}`)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	return rec
}

func runCLI(t *testing.T, args ...string) error {
	t.Helper()
	root := rootCmd()
	root.SetArgs(args)
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)
	return root.ExecuteContext(context.Background())
}

func decodeBody(t *testing.T, req seenReq) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(req.Body, &m); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, req.Body)
	}
	return m
}

func TestProjectListUnscoped(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects": `[{"id":"p1","slug":"web","name":"Web","organizationId":"org-9"}]`,
	})
	if err := runCLI(t, "project", "list"); err != nil {
		t.Fatalf("project list: %v", err)
	}
	req, ok := rec.find("GET", "/apiv1/projects")
	if !ok {
		t.Fatal("GET /apiv1/projects never hit")
	}
	if req.Query != "" {
		t.Errorf("unscoped list sent query %q, want none", req.Query)
	}
}

func TestProjectListResolvesOrgScope(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/organizations/slug/acme": `{"id":"org-9"}`,
		"GET /apiv1/projects":                `[]`,
	})
	if err := runCLI(t, "project", "list", "--org", "acme"); err != nil {
		t.Fatalf("project list --org: %v", err)
	}
	req, ok := rec.find("GET", "/apiv1/projects")
	if !ok {
		t.Fatal("GET /apiv1/projects never hit")
	}
	if req.Query != "orgId=org-9" {
		t.Errorf("query = %q, want orgId=org-9", req.Query)
	}
}

func TestProjectGetResolvesSlug(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/slug/web": `{"id":"p1"}`,
		"GET /apiv1/projects/p1":       `{"id":"p1","slug":"web","name":"Web","organizationId":"org-9","namespace":"prj-web","createdAt":"2026-01-01"}`,
	})
	if err := runCLI(t, "project", "get", "web"); err != nil {
		t.Fatalf("project get: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/projects/p1"); !ok {
		t.Fatal("GET /apiv1/projects/p1 never hit")
	}
}

func TestProjectCreatePostsBody(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/organizations/slug/acme": `{"id":"org-9"}`,
		"POST /apiv1/projects":               `{"id":"p2","slug":"api","name":"api"}`,
	})
	if err := runCLI(t, "project", "create", "--name", "api", "--description", "backend", "--org", "acme"); err != nil {
		t.Fatalf("project create: %v", err)
	}
	req, ok := rec.find("POST", "/apiv1/projects")
	if !ok {
		t.Fatal("POST /apiv1/projects never hit")
	}
	got := decodeBody(t, req)
	want := map[string]any{"organizationId": "org-9", "name": "api", "description": "backend"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v", got, want)
	}
}

func TestProjectUpdatePatchesChangedFields(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":   `{"id":"p1","slug":"web"}`,
		"PATCH /apiv1/projects/p1": `{"id":"p1"}`,
	})
	if err := runCLI(t, "project", "update", "p1", "--name", "renamed", "--repository-url", ""); err != nil {
		t.Fatalf("project update: %v", err)
	}
	req, ok := rec.find("PATCH", "/apiv1/projects/p1")
	if !ok {
		t.Fatal("PATCH /apiv1/projects/p1 never hit")
	}
	got := decodeBody(t, req)
	if got["name"] != "renamed" {
		t.Errorf("name = %v, want renamed", got["name"])
	}
	if v, present := got["repositoryUrl"]; !present || v != nil {
		t.Errorf("repositoryUrl = %v (present=%v), want explicit null", v, present)
	}
	if _, present := got["description"]; present {
		t.Error("description sent without being flagged")
	}
}

func TestProjectUpdateRequiresAField(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1"}`,
	})
	if err := runCLI(t, "project", "update", "p1"); err == nil {
		t.Fatal("expected error when no fields are flagged")
	}
	if _, ok := rec.find("PATCH", "/apiv1/projects/p1"); ok {
		t.Error("PATCH sent despite empty update")
	}
}

func TestProjectDelete(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":    `{"id":"p1","slug":"web"}`,
		"DELETE /apiv1/projects/p1": `{}`,
	})
	if err := runCLI(t, "project", "delete", "p1", "--yes"); err != nil {
		t.Fatalf("project delete: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/projects/p1"); !ok {
		t.Fatal("DELETE /apiv1/projects/p1 never hit")
	}
}

func TestProjectDeleteRefusesWithoutYes(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1"}`,
	})
	if err := runCLI(t, "project", "delete", "p1"); err == nil {
		t.Fatal("expected prompt refusal in non-interactive mode")
	}
	if _, ok := rec.find("DELETE", "/apiv1/projects/p1"); ok {
		t.Error("DELETE sent despite refused confirmation")
	}
}

func TestProjectSyncUsesNamespace(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/slug/web": `{"id":"p1","namespace":"prj-web"}`,
		"GET /apiv1/sync/prj-web":      `{"synced":true}`,
	})
	if err := runCLI(t, "project", "sync", "web"); err != nil {
		t.Fatalf("project sync: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/sync/prj-web"); !ok {
		t.Fatal("GET /apiv1/sync/prj-web never hit")
	}
}

func writeTempImage(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("png-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProjectIconSetUploadsFile(t *testing.T) {
	var gotFile, gotName string
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/apiv1/projects/p1/icon" {
			f, hdr, err := r.FormFile("file")
			if err != nil {
				w.WriteHeader(400)
				return
			}
			data, _ := io.ReadAll(f)
			f.Close()
			gotFile, gotName = string(data), hdr.Filename
			rec.add(r, nil)
			io.WriteString(w, `{"icon":"https://cdn/icon.png"}`)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/apiv1/projects/p1" {
			io.WriteString(w, `{"id":"p1","slug":"web"}`)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	icon := writeTempImage(t, "icon.png")
	if err := runCLI(t, "project", "icon", "set", "p1", icon); err != nil {
		t.Fatalf("project icon set: %v", err)
	}
	if _, ok := rec.find("POST", "/apiv1/projects/p1/icon"); !ok {
		t.Fatal("POST /apiv1/projects/p1/icon never hit")
	}
	if gotFile != "png-bytes" {
		t.Errorf("uploaded bytes = %q, want png-bytes", gotFile)
	}
	if gotName != "icon.png" {
		t.Errorf("uploaded filename = %q, want icon.png", gotName)
	}
}

func TestProjectBackgroundSetUsesProjectScope(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":                   `{"id":"p1"}`,
		"POST /apiv1/projects/p1/background-image": `{"backgroundImage":"https://cdn/bg.png"}`,
	})
	bg := writeTempImage(t, "bg.png")
	if err := runCLI(t, "project", "background", "set", bg, "--project", "p1"); err != nil {
		t.Fatalf("project background set: %v", err)
	}
	if _, ok := rec.find("POST", "/apiv1/projects/p1/background-image"); !ok {
		t.Fatal("POST /apiv1/projects/p1/background-image never hit")
	}
}

func TestProjectMemberList(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1": `{"id":"p1","members":[{"id":"m1","role":{"name":"admin"},"user":{"email":"a@b.c","firstName":"Ada"}}]}`,
	})
	if err := runCLI(t, "project", "member", "list", "--project", "p1"); err != nil {
		t.Fatalf("project member list: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/projects/p1"); !ok {
		t.Fatal("GET /apiv1/projects/p1 never hit")
	}
}

func TestProjectMemberAddPostsBody(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":          `{"id":"p1"}`,
		"POST /apiv1/projects/p1/members": `{"id":"m2"}`,
	})
	if err := runCLI(t, "project", "member", "add", "a@b.c", "--role", "viewer", "--project", "p1"); err != nil {
		t.Fatalf("project member add: %v", err)
	}
	req, ok := rec.find("POST", "/apiv1/projects/p1/members")
	if !ok {
		t.Fatal("POST /apiv1/projects/p1/members never hit")
	}
	got := decodeBody(t, req)
	want := map[string]any{"email": "a@b.c", "role": "viewer"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v", got, want)
	}
}

func TestProjectMemberAddRejectsBadRole(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{})
	if err := runCLI(t, "project", "member", "add", "a@b.c", "--role", "owner", "--project", "p1"); err == nil {
		t.Fatal("expected invalid-role error")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestProjectMemberRemove(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":               `{"id":"p1"}`,
		"DELETE /apiv1/projects/p1/members/m1": `{}`,
	})
	if err := runCLI(t, "project", "member", "remove", "m1", "--project", "p1", "--yes"); err != nil {
		t.Fatalf("project member remove: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/projects/p1/members/m1"); !ok {
		t.Fatal("DELETE /apiv1/projects/p1/members/m1 never hit")
	}
}

func TestProjectMemberSetRole(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":              `{"id":"p1"}`,
		"PATCH /apiv1/projects/p1/members/m1": `{}`,
	})
	if err := runCLI(t, "project", "member", "set-role", "m1", "admin", "--project", "p1"); err != nil {
		t.Fatalf("project member set-role: %v", err)
	}
	req, ok := rec.find("PATCH", "/apiv1/projects/p1/members/m1")
	if !ok {
		t.Fatal("PATCH /apiv1/projects/p1/members/m1 never hit")
	}
	got := decodeBody(t, req)
	if !reflect.DeepEqual(got, map[string]any{"role": "admin"}) {
		t.Errorf("body = %v, want {role: admin}", got)
	}
}

func TestProjectInvitationRevoke(t *testing.T) {
	rec := startProjectAPI(t, map[string]string{
		"GET /apiv1/projects/p1":                   `{"id":"p1"}`,
		"DELETE /apiv1/projects/p1/invitations/i1": `{}`,
	})
	if err := runCLI(t, "project", "invitation", "revoke", "i1", "--project", "p1", "--yes"); err != nil {
		t.Fatalf("project invitation revoke: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/projects/p1/invitations/i1"); !ok {
		t.Fatal("DELETE /apiv1/projects/p1/invitations/i1 never hit")
	}
}
