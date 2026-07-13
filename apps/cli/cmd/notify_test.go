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

func notifyTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	root := rootCmd()
	for _, c := range root.Commands() {
		if c.Name() == "notify" {
			return root
		}
	}
	root.AddCommand(notifyCmd())
	return root
}

func notifyDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

// notifyTestServer serves org slug resolution plus one channel route handler.
func notifyTestServer(t *testing.T, handle func(w http.ResponseWriter, r *http.Request) bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/organizations/slug/myorg" {
			io.WriteString(w, `{"id":"o1","slug":"myorg"}`)
			return
		}
		if handle(w, r) {
			return
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(404)
	}))
}

func TestNotifyChannelListOrgScope(t *testing.T) {
	var gotMethod, gotPath string
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels" {
			return false
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[{"id":"c1","name":"alerts","type":"discord","enabled":true,"events":["deploy.failed","pod.crashing"],"projectIds":null,"config":{"urlConfigured":true},"lastDelivery":null}]`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "list", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/organizations/o1/notification-channels" {
		t.Errorf("request = %s %s, want GET /apiv1/organizations/o1/notification-channels", gotMethod, gotPath)
	}
}

func TestNotifyChannelCreateWebhookBody(t *testing.T) {
	var gotBody map[string]any
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodPost || r.URL.Path != "/apiv1/organizations/o1/notification-channels" {
			return false
		}
		gotBody = notifyDecodeBody(t, r)
		io.WriteString(w, `{"id":"c1","webhookSecret":"sec123"}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"notify", "channel", "create", "--org", "myorg",
		"--type", "webhook", "--name", "hooky",
		"--url", "https://example.com/hook",
		"--events", "deploy.failed,pod.crashing",
		"--project", "p1",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel create: %v", err)
	}
	if gotBody["name"] != "hooky" || gotBody["type"] != "webhook" {
		t.Errorf("name/type = %v/%v, want hooky/webhook", gotBody["name"], gotBody["type"])
	}
	config, _ := gotBody["config"].(map[string]any)
	if !reflect.DeepEqual(config, map[string]any{"url": "https://example.com/hook"}) {
		t.Errorf("config = %v, want only the url field", gotBody["config"])
	}
	if !reflect.DeepEqual(gotBody["events"], []any{"deploy.failed", "pod.crashing"}) {
		t.Errorf("events = %v, want the two comma-split events", gotBody["events"])
	}
	if !reflect.DeepEqual(gotBody["projectIds"], []any{"p1"}) {
		t.Errorf("projectIds = %v, want [p1]", gotBody["projectIds"])
	}
}

func TestNotifyChannelCreateEmailRecipients(t *testing.T) {
	var gotBody map[string]any
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != http.MethodPost || r.URL.Path != "/apiv1/organizations/o1/notification-channels" {
			return false
		}
		gotBody = notifyDecodeBody(t, r)
		io.WriteString(w, `{"id":"c2"}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{
		"notify", "channel", "create", "--org", "myorg",
		"--type", "email", "--name", "mail",
		"--email", "a@example.com", "--email", "b@example.com",
		"--events", "backup.failed",
	})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel create email: %v", err)
	}
	config, _ := gotBody["config"].(map[string]any)
	if !reflect.DeepEqual(config, map[string]any{"recipients": []any{"a@example.com", "b@example.com"}}) {
		t.Errorf("config = %v, want the recipients list", gotBody["config"])
	}
	if _, present := gotBody["projectIds"]; present {
		t.Errorf("body = %v, want projectIds omitted without --project", gotBody)
	}
}

func TestNotifyChannelCreateValidation(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	cases := []struct {
		name string
		args []string
		want string
	}{
		{
			name: "bogus type",
			args: []string{"--type", "carrier-pigeon", "--name", "n", "--events", "deploy.failed"},
			want: "--type must be one of",
		},
		{
			name: "discord without url",
			args: []string{"--type", "discord", "--name", "n", "--events", "deploy.failed"},
			want: "--url is required",
		},
		{
			name: "email without recipients",
			args: []string{"--type", "email", "--name", "n", "--events", "deploy.failed"},
			want: "--email is required",
		},
		{
			name: "email with url",
			args: []string{"--type", "email", "--name", "n", "--events", "deploy.failed", "--email", "a@x.com", "--url", "https://x.com"},
			want: "--url does not apply",
		},
		{
			name: "unknown event",
			args: []string{"--type", "discord", "--name", "n", "--url", "https://x.com/h", "--events", "deploy.exploded"},
			want: "unknown event(s): deploy.exploded",
		},
	}
	for _, tc := range cases {
		root := notifyTestRoot(t, srv.URL)
		root.SetArgs(append([]string{"notify", "channel", "create", "--org", "myorg"}, tc.args...))
		err := root.Execute()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want it to contain %q", tc.name, err, tc.want)
		}
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestNotifyChannelUpdateBody(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1" {
			return false
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		gotBody = notifyDecodeBody(t, r)
		io.WriteString(w, `{"id":"c1"}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "update", "c1", "--org", "myorg", "--name", "renamed", "--disabled"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel update: %v", err)
	}
	if gotMethod != http.MethodPatch || gotPath != "/apiv1/organizations/o1/notification-channels/c1" {
		t.Errorf("request = %s %s, want PATCH /apiv1/organizations/o1/notification-channels/c1", gotMethod, gotPath)
	}
	if gotBody["name"] != "renamed" || gotBody["enabled"] != false {
		t.Errorf("name/enabled = %v/%v, want renamed/false", gotBody["name"], gotBody["enabled"])
	}
	for _, k := range []string{"config", "events", "projectIds", "type"} {
		if _, present := gotBody[k]; present {
			t.Errorf("body = %v, want %s omitted when its flags are untouched", gotBody, k)
		}
	}
}

func TestNotifyChannelUpdateAllProjectsClearsScope(t *testing.T) {
	var gotBody map[string]any
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1" {
			return false
		}
		gotBody = notifyDecodeBody(t, r)
		io.WriteString(w, `{"id":"c1"}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "update", "c1", "--org", "myorg", "--all-projects"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel update --all-projects: %v", err)
	}
	if v, ok := gotBody["projectIds"]; !ok || v != nil {
		t.Errorf("projectIds = %v (present=%v), want explicit null", v, ok)
	}
}

func TestNotifyChannelUpdateRequiresChange(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "update", "c1", "--org", "myorg"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "nothing to update") {
		t.Fatalf("want a nothing-to-update error, got %v", err)
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestNotifyChannelDelete(t *testing.T) {
	var gotMethod, gotPath string
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1" {
			return false
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "delete", "c1", "--org", "myorg", "--yes"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel delete: %v", err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/apiv1/organizations/o1/notification-channels/c1" {
		t.Errorf("request = %s %s, want DELETE /apiv1/organizations/o1/notification-channels/c1", gotMethod, gotPath)
	}
}

func TestNotifyChannelDeleteRefusesWithoutYes(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(500)
	}))
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "delete", "c1", "--org", "myorg"})
	if err := root.Execute(); err == nil {
		t.Fatal("expected prompt-refused error without --yes")
	}
	if hits != 0 {
		t.Errorf("server saw %d requests, want 0", hits)
	}
}

func TestNotifyChannelTestSuccess(t *testing.T) {
	var gotMethod, gotPath string
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1/test" {
			return false
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `{"success":true}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "test", "c1", "--org", "myorg"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify channel test: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/organizations/o1/notification-channels/c1/test" {
		t.Errorf("request = %s %s, want POST /apiv1/organizations/o1/notification-channels/c1/test", gotMethod, gotPath)
	}
}

func TestNotifyChannelTestFailureSurfacesError(t *testing.T) {
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1/test" {
			return false
		}
		io.WriteString(w, `{"success":false,"error":"HTTP 404"}`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "channel", "test", "c1", "--org", "myorg"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "HTTP 404") {
		t.Fatalf("want a test-failure error naming HTTP 404, got %v", err)
	}
}

func TestNotifyDeliveries(t *testing.T) {
	var gotMethod, gotPath string
	srv := notifyTestServer(t, func(w http.ResponseWriter, r *http.Request) bool {
		if r.URL.Path != "/apiv1/organizations/o1/notification-channels/c1/deliveries" {
			return false
		}
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[{"id":"d2","event":"deploy.failed","status":"failed","error":"HTTP 500","createdAt":"2026-07-12T00:00:00Z"},{"id":"d1","event":"test","status":"sent","error":null,"createdAt":"2026-07-11T00:00:00Z"}]`)
		return true
	})
	defer srv.Close()

	root := notifyTestRoot(t, srv.URL)
	root.SetArgs([]string{"notify", "deliveries", "c1", "--org", "myorg", "--limit", "1"})
	if err := root.Execute(); err != nil {
		t.Fatalf("notify deliveries: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/organizations/o1/notification-channels/c1/deliveries" {
		t.Errorf("request = %s %s, want GET /apiv1/organizations/o1/notification-channels/c1/deliveries", gotMethod, gotPath)
	}
}
