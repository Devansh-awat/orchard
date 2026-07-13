package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/spf13/cobra"
)

// webhookTestRoot deliberately leaves a stored login token in the env: the
// webhook client must ignore it and authenticate with the webhook token only.
func webhookTestRoot(t *testing.T, srvURL string) *cobra.Command {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "orch_usertoken")
	root := rootCmd()
	tailscaleTestRegister(root, webhookCmd())
	return root
}

func webhookDecodeBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Errorf("decode body: %v", err)
	}
	return m
}

func TestWebhookDeploySendsWebhookTokenAsBearer(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotBody = webhookDecodeBody(t, r)
		io.WriteString(w, `{"ok":true,"deploymentId":"d1","action":"restart"}`)
	}))
	defer srv.Close()

	root := webhookTestRoot(t, srv.URL)
	root.SetArgs([]string{"webhook", "deploy", "wh_secret"})
	if err := root.Execute(); err != nil {
		t.Fatalf("webhook deploy: %v", err)
	}
	if gotMethod != http.MethodPost || gotPath != "/apiv1/webhooks/deploy" {
		t.Errorf("request = %s %s, want POST /apiv1/webhooks/deploy", gotMethod, gotPath)
	}
	if gotAuth != "Bearer wh_secret" {
		t.Errorf("Authorization = %q, want the webhook token, never the login token", gotAuth)
	}
	if !reflect.DeepEqual(gotBody, map[string]any{}) {
		t.Errorf("body = %v, want empty object without --image/--tag", gotBody)
	}
}

func TestWebhookDeployImageTagBody(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody = webhookDecodeBody(t, r)
		io.WriteString(w, `{"ok":true,"deploymentId":"d1","action":"image-update"}`)
	}))
	defer srv.Close()

	root := webhookTestRoot(t, srv.URL)
	root.SetArgs([]string{"webhook", "deploy", "wh_secret", "--image", "nginx", "--tag", "1.27"})
	if err := root.Execute(); err != nil {
		t.Fatalf("webhook deploy --image --tag: %v", err)
	}
	if gotBody["image"] != "nginx" || gotBody["tag"] != "1.27" {
		t.Errorf("image/tag = %v/%v, want nginx/1.27", gotBody["image"], gotBody["tag"])
	}
}

func TestWebhookDeployWorksWithoutLogin(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		io.WriteString(w, `{"ok":true,"deploymentId":"d1","action":"restart"}`)
	}))
	defer srv.Close()

	root := webhookTestRoot(t, srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "")
	root.SetArgs([]string{"webhook", "deploy", "wh_secret"})
	if err := root.Execute(); err != nil {
		t.Fatalf("webhook deploy without login: %v", err)
	}
	if gotAuth != "Bearer wh_secret" {
		t.Errorf("Authorization = %q, want Bearer wh_secret", gotAuth)
	}
}
