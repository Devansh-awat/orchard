package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestOrgRegistryCommands(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			mux := http.NewServeMux()
			serveOrgHQ(mux)
			orgTestServer(t, mux)
			orgFlag = "hq"
			yesFlag = true
			calls := 0
			mux.HandleFunc("/apiv1/organizations/o1/registry-credentials", func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != method {
					t.Errorf("method = %s, want %s", r.Method, method)
				}
				if r.Method == http.MethodPut {
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
					if body["registry"] != "dhi.io" || body["username"] != "docker-user" || body["password"] != "test-token" {
						t.Errorf("unexpected credential payload: %v", body)
					}
					io.WriteString(w, `{"id":"c1","registry":"dhi.io","username":"docker-user"}`)
				} else {
					io.WriteString(w, `[]`)
				}
			})
			mux.HandleFunc("/apiv1/organizations/o1/registry-credentials/c1", func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodDelete {
					t.Errorf("method = %s", r.Method)
				}
				io.WriteString(w, `{"success":true}`)
			})
			args := []string{"registry", "list"}
			if method == http.MethodPut {
				args = []string{"registry", "set", "dhi.io", "--username", "docker-user", "--password", "test-token"}
			}
			if method == http.MethodDelete {
				args = []string{"registry", "remove", "c1"}
			}
			if err := runOrg(t, args...); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Errorf("requests = %d, want 1", calls)
			}
		})
	}
}

func TestOrgRegistryRemoveRequiresConfirmation(t *testing.T) {
	calls := 0
	orgTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	orgFlag = "hq"
	if err := runOrg(t, "registry", "remove", "c1"); err == nil {
		t.Fatal("expected confirmation refusal")
	}
	if calls != 0 {
		t.Errorf("requests = %d, want 0", calls)
	}
}
