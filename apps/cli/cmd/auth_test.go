package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func runLoginWithoutTerminal(t *testing.T, args ...string) error {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", "")
	t.Setenv("ORCHARD_API_TOKEN", "")
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer devNull.Close()
	stdin := os.Stdin
	os.Stdin = devNull
	defer func() { os.Stdin = stdin }()
	c := authLoginCmd()
	c.SilenceUsage = true
	c.SilenceErrors = true
	c.SetArgs(append([]string{}, args...))
	return c.Execute()
}

func TestNoBrowserWithoutTerminalAsksForAnInstanceNotAToken(t *testing.T) {
	err := runLoginWithoutTerminal(t, "--no-browser")
	if err == nil || !strings.Contains(err.Error(), "--api-url") {
		t.Fatalf("err = %v, want it to name --api-url", err)
	}
}

func TestLoginWithoutTerminalNamesTheWaysIn(t *testing.T) {
	err := runLoginWithoutTerminal(t, "--api-url", startOrchard(t).URL)
	if err == nil {
		t.Fatal("expected an error with nothing on stdin")
	}
	for _, want := range []string{"--token", "--no-browser"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want it to name %s", err, want)
		}
	}
}

// authStartAPI serves routes keyed "METHOD /path" and records every request,
// mirroring startProjectAPI but scoped to this file's ownership.
func authStartAPI(t *testing.T, routes map[string]string) *recorder {
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
	return rec
}

// authRunUser executes the user command tree directly: userCmd() is not yet
// registered on root (root.go is owned elsewhere), so runCLI cannot reach it.
func authRunUser(t *testing.T, args ...string) error {
	t.Helper()
	c := userCmd()
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	c.SetArgs(args)
	return c.ExecuteContext(context.Background())
}

func TestAuthTokenList(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"GET /apiv1/auth/tokens": `[{"id":"t1","name":"ci","scopes":["read"],"restrictedProjectIds":[],"lastUsedAt":null,"expiresAt":"2026-10-01T00:00:00Z"}]`,
	})
	if err := runCLI(t, "auth", "token", "list"); err != nil {
		t.Fatalf("auth token list: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/auth/tokens"); !ok {
		t.Fatal("GET /apiv1/auth/tokens never hit")
	}
}

func TestAuthTokenCreatePostsBody(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"GET /apiv1/projects/slug/web": `{"id":"p1"}`,
		"POST /apiv1/auth/tokens":      `{"id":"t2","name":"ci","token":"orch_secret","scopes":["read","deploy"],"restrictedProjectIds":["p1"],"expiresAt":"2026-08-11T00:00:00Z"}`,
	})
	if err := runCLI(t, "auth", "token", "create", "--name", "ci", "--scope", "read", "--scope", "deploy", "--project", "web", "--expires-in", "30d"); err != nil {
		t.Fatalf("auth token create: %v", err)
	}
	req, ok := rec.find("POST", "/apiv1/auth/tokens")
	if !ok {
		t.Fatal("POST /apiv1/auth/tokens never hit")
	}
	got := decodeBody(t, req)
	if got["name"] != "ci" {
		t.Errorf("name = %v, want ci", got["name"])
	}
	if !reflect.DeepEqual(got["scopes"], []any{"read", "deploy"}) {
		t.Errorf("scopes = %v, want [read deploy]", got["scopes"])
	}
	if !reflect.DeepEqual(got["restrictedProjectIds"], []any{"p1"}) {
		t.Errorf("restrictedProjectIds = %v, want [p1] (slug resolved to id)", got["restrictedProjectIds"])
	}
	exp, ok := got["expiresAt"].(string)
	if !ok {
		t.Fatalf("expiresAt = %v, want RFC3339 string", got["expiresAt"])
	}
	at, err := time.Parse(time.RFC3339, exp)
	if err != nil {
		t.Fatalf("expiresAt %q does not parse: %v", exp, err)
	}
	d := time.Until(at)
	if d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Errorf("expiresAt is %v away, want ~30d", d)
	}
}

func TestAuthTokenCreateOmitsOptionalFields(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"POST /apiv1/auth/tokens": `{"id":"t3","name":"plain","token":"orch_x","scopes":["read"],"restrictedProjectIds":[],"expiresAt":"2026-10-10T00:00:00Z"}`,
	})
	if err := runCLI(t, "auth", "token", "create", "--name", "plain"); err != nil {
		t.Fatalf("auth token create: %v", err)
	}
	req, ok := rec.find("POST", "/apiv1/auth/tokens")
	if !ok {
		t.Fatal("POST /apiv1/auth/tokens never hit")
	}
	got := decodeBody(t, req)
	if !reflect.DeepEqual(got, map[string]any{"name": "plain"}) {
		t.Errorf("body = %v, want only {name: plain} (server owns the defaults)", got)
	}
}

func TestAuthTokenCreateRejectsBadScope(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := runCLI(t, "auth", "token", "create", "--name", "ci", "--scope", "admin"); err == nil {
		t.Fatal("expected invalid-scope error")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestAuthTokenCreateRejectsBadExpiresIn(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := runCLI(t, "auth", "token", "create", "--name", "ci", "--expires-in", "soon"); err == nil {
		t.Fatal("expected invalid --expires-in error")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestAuthParseExpiresIn(t *testing.T) {
	tests := []struct {
		in      string
		want    time.Duration
		wantErr bool
	}{
		{"30d", 30 * 24 * time.Hour, false},
		{"90d", 90 * 24 * time.Hour, false},
		{"12h", 12 * time.Hour, false},
		{"45m", 45 * time.Minute, false},
		{"0d", 0, true},
		{"-2d", 0, true},
		{"-5h", 0, true},
		{"soon", 0, true},
		{"", 0, true},
	}
	for _, tt := range tests {
		got, err := authParseExpiresIn(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("authParseExpiresIn(%q) = %v, want error", tt.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("authParseExpiresIn(%q): %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("authParseExpiresIn(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestAuthTokenRevoke(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"DELETE /apiv1/auth/tokens/t1": `{"message":"Token revoked"}`,
	})
	if err := runCLI(t, "auth", "token", "revoke", "t1", "--yes"); err != nil {
		t.Fatalf("auth token revoke: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/auth/tokens/t1"); !ok {
		t.Fatal("DELETE /apiv1/auth/tokens/t1 never hit")
	}
}

func TestAuthTokenRevokeRefusesWithoutYes(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := runCLI(t, "auth", "token", "revoke", "t1"); err == nil {
		t.Fatal("expected prompt refusal in non-interactive mode")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestAuthSessionList(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"GET /apiv1/auth/sessions": `{"sessions":[{"id":"s1","deviceName":"Chrome on macOS","location":"Boston, US","ipAddress":"1.2.3.4","authMethod":"otp","lastActiveAt":"2026-07-11T00:00:00Z","isCurrent":true}]}`,
	})
	if err := runCLI(t, "auth", "session", "list"); err != nil {
		t.Fatalf("auth session list: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/auth/sessions"); !ok {
		t.Fatal("GET /apiv1/auth/sessions never hit")
	}
}

func TestAuthSessionRevoke(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"DELETE /apiv1/auth/sessions/s1": `{"success":true}`,
	})
	if err := runCLI(t, "auth", "session", "revoke", "s1", "--yes"); err != nil {
		t.Fatalf("auth session revoke: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/auth/sessions/s1"); !ok {
		t.Fatal("DELETE /apiv1/auth/sessions/s1 never hit")
	}
}

func TestAuthSessionRevokeAll(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"POST /apiv1/auth/sessions/revoke-all": `{"success":true,"revokedCount":3}`,
	})
	if err := runCLI(t, "auth", "session", "revoke-all", "--yes"); err != nil {
		t.Fatalf("auth session revoke-all: %v", err)
	}
	req, ok := rec.find("POST", "/apiv1/auth/sessions/revoke-all")
	if !ok {
		t.Fatal("POST /apiv1/auth/sessions/revoke-all never hit")
	}
	if len(req.Body) != 0 {
		t.Errorf("revoke-all sent body %q, want none", req.Body)
	}
}

func TestAuthSessionRevokeAllRefusesWithoutYes(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := runCLI(t, "auth", "session", "revoke-all"); err == nil {
		t.Fatal("expected prompt refusal in non-interactive mode")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestUserProfileFetchesMe(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"GET /apiv1/auth/me": `{"id":"u1","email":"a@b.c","username":"ada","firstName":"Ada","lastName":"L","imageUrl":null,"hackClubId":"hc1","setupCompleted":true}`,
	})
	if err := authRunUser(t, "profile"); err != nil {
		t.Fatalf("user profile: %v", err)
	}
	if _, ok := rec.find("GET", "/apiv1/auth/me"); !ok {
		t.Fatal("GET /apiv1/auth/me never hit")
	}
}

func TestUserProfileUpdatePatchesChangedFields(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"PATCH /apiv1/auth/me": `{"id":"u1","username":"neo"}`,
	})
	if err := authRunUser(t, "profile", "update", "--username", "neo", "--first-name", ""); err != nil {
		t.Fatalf("user profile update: %v", err)
	}
	req, ok := rec.find("PATCH", "/apiv1/auth/me")
	if !ok {
		t.Fatal("PATCH /apiv1/auth/me never hit")
	}
	got := decodeBody(t, req)
	if got["username"] != "neo" {
		t.Errorf("username = %v, want neo", got["username"])
	}
	if v, present := got["firstName"]; !present || v != nil {
		t.Errorf("firstName = %v (present=%v), want explicit null", v, present)
	}
	if _, present := got["lastName"]; present {
		t.Error("lastName sent without being flagged")
	}
}

func TestUserProfileUpdateRequiresAField(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := authRunUser(t, "profile", "update"); err == nil {
		t.Fatal("expected error when no fields are flagged")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestUserProfileUpdateRejectsEmptyUsername(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := authRunUser(t, "profile", "update", "--username", ""); err == nil {
		t.Fatal("expected empty-username error")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestUserAvatarSetUploadsFile(t *testing.T) {
	var gotFile, gotName string
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/apiv1/auth/me/avatar" {
			f, hdr, err := r.FormFile("file")
			if err != nil {
				w.WriteHeader(400)
				return
			}
			data, _ := io.ReadAll(f)
			f.Close()
			gotFile, gotName = string(data), hdr.Filename
			rec.add(r, nil)
			io.WriteString(w, `{"id":"u1","imageUrl":"https://cdn/avatar.png"}`)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")

	avatar := writeTempImage(t, "avatar.png")
	if err := authRunUser(t, "avatar", "set", avatar); err != nil {
		t.Fatalf("user avatar set: %v", err)
	}
	if _, ok := rec.find("POST", "/apiv1/auth/me/avatar"); !ok {
		t.Fatal("POST /apiv1/auth/me/avatar never hit")
	}
	if gotFile != "png-bytes" {
		t.Errorf("uploaded bytes = %q, want png-bytes", gotFile)
	}
	if gotName != "avatar.png" {
		t.Errorf("uploaded filename = %q, want avatar.png", gotName)
	}
}

func TestUserAvatarDelete(t *testing.T) {
	rec := authStartAPI(t, map[string]string{
		"DELETE /apiv1/auth/me/avatar": `{"id":"u1","imageUrl":null}`,
	})
	withYes(t)
	if err := authRunUser(t, "avatar", "delete"); err != nil {
		t.Fatalf("user avatar delete: %v", err)
	}
	if _, ok := rec.find("DELETE", "/apiv1/auth/me/avatar"); !ok {
		t.Fatal("DELETE /apiv1/auth/me/avatar never hit")
	}
}

func TestUserAvatarDeleteRefusesWithoutYes(t *testing.T) {
	rec := authStartAPI(t, map[string]string{})
	if err := authRunUser(t, "avatar", "delete"); err == nil {
		t.Fatal("expected prompt refusal in non-interactive mode")
	}
	if len(rec.reqs) != 0 {
		t.Errorf("server saw %d requests, want 0", len(rec.reqs))
	}
}

func TestSessionTableLeavesOutAnEmptyLocationColumn(t *testing.T) {
	headers, rows := sessionTable([]map[string]any{{"id": "s1", "location": nil, "ipAddress": "1.2.3.4"}})
	if strings.Contains(strings.Join(headers, ","), "location") {
		t.Fatalf("no session has a location, but the headers are %v", headers)
	}
	if len(rows[0]) != len(headers) {
		t.Fatalf("row has %d cells for %d headers", len(rows[0]), len(headers))
	}
}

func TestSessionTableMarksASessionWithoutALocation(t *testing.T) {
	headers, rows := sessionTable([]map[string]any{
		{"id": "s1", "location": "Boston, US"},
		{"id": "s2"},
	})
	if headers[2] != "location" || rows[0][2] != "Boston, US" || rows[1][2] != "-" {
		t.Fatalf("headers %v rows %v", headers, rows)
	}
}
