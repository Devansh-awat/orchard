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
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
)

// orgTestServer points client() at an httptest server and neutralizes any
// scope/confirm state leaking in from the process env or other tests.
func orgTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srv.URL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	prevOrg, prevYes := orgFlag, yesFlag
	orgFlag, yesFlag = "", false
	t.Cleanup(func() { orgFlag, yesFlag = prevOrg, prevYes })
	return srv
}

func runOrg(t *testing.T, args ...string) error {
	t.Helper()
	c := orgCmd()
	c.SetArgs(args)
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	return c.Execute()
}

// serveOrgHQ registers the slug-resolution route used by resolveOrg.
func serveOrgHQ(mux *http.ServeMux) {
	mux.HandleFunc("/apiv1/organizations/slug/hq", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"o1","slug":"hq","name":"HQ"}`)
	})
}

func TestOrgList(t *testing.T) {
	var gotMethod, gotPath string
	orgTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[{"id":"o1","slug":"hq","name":"HQ","plan":"free"}]`)
	}))
	if err := runOrg(t, "list"); err != nil {
		t.Fatalf("org list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/organizations/user" {
		t.Errorf("request = %s %s, want GET /apiv1/organizations/user", gotMethod, gotPath)
	}
}

func TestOrgGetShowsWhySSORefusedIt(t *testing.T) {
	const why = "This organization requires single sign-on."
	mux := http.NewServeMux()
	mux.HandleFunc("/apiv1/organizations/slug/hq", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"error":"org_sso_required","message":"`+why+`"}`)
	})
	orgTestServer(t, mux)
	err := runOrg(t, "get", "hq")
	if err == nil || !strings.Contains(err.Error(), why) {
		t.Fatalf("org get error = %v, want the server's reason", err)
	}
}

func TestProjectNotFoundNamesOrgsBehindSSO(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/apiv1/projects", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[]`)
	})
	mux.HandleFunc("/apiv1/organizations/user", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"slug":"open"},{"slug":"acme","ssoRequired":true}]`)
	})
	srv := orgTestServer(t, mux)
	_, err := resolveProject(context.Background(), api.New(srv.URL, "tok"), "web")
	if err == nil || !strings.Contains(err.Error(), "single sign-on: acme") {
		t.Fatalf("resolveProject error = %v, want the SSO hint", err)
	}
}

func TestOrgGetByArg(t *testing.T) {
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	orgTestServer(t, mux)
	if err := runOrg(t, "get", "hq"); err != nil {
		t.Fatalf("org get hq: %v", err)
	}
}

func TestOrgGetUsesScope(t *testing.T) {
	var gotByID bool
	mux := http.NewServeMux()
	mux.HandleFunc("/apiv1/organizations/o1", func(w http.ResponseWriter, r *http.Request) {
		gotByID = true
		io.WriteString(w, `{"id":"o1","slug":"hq","name":"HQ"}`)
	})
	orgTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "o1")
	if err := runOrg(t, "get"); err != nil {
		t.Fatalf("org get (scoped): %v", err)
	}
	if !gotByID {
		t.Error("expected fallback GET /apiv1/organizations/o1")
	}
}

func TestOrgGetNoScope(t *testing.T) {
	orgTestServer(t, http.NewServeMux())
	if err := runOrg(t, "get"); err == nil {
		t.Fatal("expected no-scope error, got nil")
	}
}

func TestOrgUpdate(t *testing.T) {
	var patchBody, subdomainBody map[string]any
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("PATCH /apiv1/organizations/o1", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&patchBody); err != nil {
			t.Errorf("decode patch body: %v", err)
		}
		io.WriteString(w, `{}`)
	})
	mux.HandleFunc("PATCH /apiv1/organizations/o1/subdomain", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&subdomainBody); err != nil {
			t.Errorf("decode subdomain body: %v", err)
		}
		io.WriteString(w, `{}`)
	})
	orgTestServer(t, mux)

	if err := runOrg(t, "update", "hq", "--name", "New HQ", "--public-ip", "1.2.3.4", "--subdomain", "hq"); err != nil {
		t.Fatalf("org update: %v", err)
	}
	want := map[string]any{"name": "New HQ", "databasePublicIp": "1.2.3.4"}
	if !reflect.DeepEqual(patchBody, want) {
		t.Errorf("patch body = %v, want %v", patchBody, want)
	}
	if !reflect.DeepEqual(subdomainBody, map[string]any{"subdomain": "hq"}) {
		t.Errorf("subdomain body = %v, want {subdomain: hq}", subdomainBody)
	}
}

func TestOrgUpdateClearsPublicIP(t *testing.T) {
	var patchBody map[string]any
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("PATCH /apiv1/organizations/o1", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&patchBody); err != nil {
			t.Errorf("decode patch body: %v", err)
		}
		io.WriteString(w, `{}`)
	})
	orgTestServer(t, mux)

	if err := runOrg(t, "update", "hq", "--public-ip", ""); err != nil {
		t.Fatalf("org update: %v", err)
	}
	if v, ok := patchBody["databasePublicIp"]; !ok || v != nil {
		t.Errorf("databasePublicIp = %v (present=%v), want explicit null", v, ok)
	}
}

func TestOrgUpdateNothing(t *testing.T) {
	orgTestServer(t, http.NewServeMux())
	if err := runOrg(t, "update", "hq"); err == nil {
		t.Fatal("expected nothing-to-update error, got nil")
	}
}

func TestOrgAvatarSet(t *testing.T) {
	var gotFilename string
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("POST /apiv1/organizations/o1/avatar", func(w http.ResponseWriter, r *http.Request) {
		f, hdr, err := r.FormFile("file")
		if err != nil {
			t.Errorf("multipart field %q missing: %v", "file", err)
			w.WriteHeader(400)
			return
		}
		defer f.Close()
		gotFilename = hdr.Filename
		io.WriteString(w, `{}`)
	})
	orgTestServer(t, mux)

	img := filepath.Join(t.TempDir(), "logo.png")
	if err := os.WriteFile(img, []byte("png-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runOrg(t, "avatar", "set", "hq", img); err != nil {
		t.Fatalf("org avatar set: %v", err)
	}
	if gotFilename != "logo.png" {
		t.Errorf("uploaded filename = %q, want logo.png", gotFilename)
	}
}

func TestOrgAvatarDelete(t *testing.T) {
	var deleted bool
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/avatar", func(w http.ResponseWriter, r *http.Request) {
		deleted = true
		io.WriteString(w, `{}`)
	})
	orgTestServer(t, mux)

	yesFlag = true
	if err := runOrg(t, "avatar", "delete", "hq"); err != nil {
		t.Fatalf("org avatar delete: %v", err)
	}
	if !deleted {
		t.Error("DELETE /apiv1/organizations/o1/avatar was never called")
	}
}

// without --yes and without a TTY the delete must refuse before mutating.
func TestOrgAvatarDeleteRefusesWithoutYes(t *testing.T) {
	var deleted bool
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/avatar", func(w http.ResponseWriter, r *http.Request) {
		deleted = true
	})
	orgTestServer(t, mux)

	if err := runOrg(t, "avatar", "delete", "hq"); err == nil {
		t.Fatal("expected confirmation refusal, got nil")
	}
	if deleted {
		t.Error("delete fired despite refused confirmation")
	}
}

func TestOrgBackupSettingsGet(t *testing.T) {
	var gotSettings bool
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("GET /apiv1/organizations/o1/backup-settings", func(w http.ResponseWriter, r *http.Request) {
		gotSettings = true
		io.WriteString(w, `{"endpoint":"https://x.r2.cloudflarestorage.com","bucket":"b","region":"auto","accessKeyConfigured":true,"accessKeyLast4":"1234","secretKeyConfigured":true,"databasePublicIp":null}`)
	})
	orgTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runOrg(t, "backup-settings", "get"); err != nil {
		t.Fatalf("org backup-settings get: %v", err)
	}
	if !gotSettings {
		t.Error("GET /apiv1/organizations/o1/backup-settings was never called")
	}
}

func TestOrgBackupSettingsSet(t *testing.T) {
	var patchBody map[string]any
	mux := http.NewServeMux()
	serveOrgHQ(mux)
	mux.HandleFunc("PATCH /apiv1/organizations/o1", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&patchBody); err != nil {
			t.Errorf("decode patch body: %v", err)
		}
		io.WriteString(w, `{}`)
	})
	orgTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	err := runOrg(t, "backup-settings", "set",
		"--endpoint", "https://x.r2.cloudflarestorage.com",
		"--bucket", "b",
		"--secret-key", "sek",
		"--access-key", "")
	if err != nil {
		t.Fatalf("org backup-settings set: %v", err)
	}
	want := map[string]any{
		"backupR2Endpoint":  "https://x.r2.cloudflarestorage.com",
		"backupR2Bucket":    "b",
		"backupR2SecretKey": "sek",
		"backupR2AccessKey": nil,
	}
	if !reflect.DeepEqual(patchBody, want) {
		t.Errorf("patch body = %v, want %v", patchBody, want)
	}
	if _, ok := patchBody["backupR2Region"]; ok {
		t.Error("region was sent despite --region not being passed")
	}
}

func TestOrgBackupSettingsSetNothing(t *testing.T) {
	orgTestServer(t, http.NewServeMux())
	if err := runOrg(t, "backup-settings", "set"); err == nil {
		t.Fatal("expected nothing-to-set error, got nil")
	}
}
