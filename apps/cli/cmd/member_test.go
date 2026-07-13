package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

// memberTestServer points client() at an httptest server and neutralizes any
// scope/confirm state leaking in from the process env or other tests.
func memberTestServer(t *testing.T, handler http.Handler) *httptest.Server {
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

func runMember(t *testing.T, args ...string) error {
	t.Helper()
	c := memberCmd()
	c.SetArgs(args)
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	return c.Execute()
}

func runInvitation(t *testing.T, args ...string) error {
	t.Helper()
	c := invitationCmd()
	c.SetArgs(args)
	c.SetOut(io.Discard)
	c.SetErr(io.Discard)
	return c.Execute()
}

// memberServeOrgHQ registers the slug-resolution route used by resolveOrg.
func memberServeOrgHQ(mux *http.ServeMux) {
	mux.HandleFunc("/apiv1/organizations/slug/hq", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"o1","slug":"hq","name":"HQ"}`)
	})
}

func TestMemberList(t *testing.T) {
	var listed bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("GET /apiv1/organizations/o1/members", func(w http.ResponseWriter, r *http.Request) {
		listed = true
		io.WriteString(w, `[{"id":"m1","role":"owner","addedAt":"2026-01-01T00:00:00Z","user":{"id":"u1","email":"a@b.c","firstName":"Ada","lastName":"L"}}]`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "list"); err != nil {
		t.Fatalf("member list: %v", err)
	}
	if !listed {
		t.Error("GET /apiv1/organizations/o1/members was never called")
	}
}

func TestMemberListNoScope(t *testing.T) {
	memberTestServer(t, http.NewServeMux())
	if err := runMember(t, "list"); err == nil {
		t.Fatal("expected no-scope error, got nil")
	}
}

func TestMemberInvitePostsBody(t *testing.T) {
	var body map[string]any
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("POST /apiv1/organizations/o1/members", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode invite body: %v", err)
		}
		io.WriteString(w, `{"id":"inv1","email":"new@b.c","role":"admin"}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "invite", "new@b.c", "--role", "admin"); err != nil {
		t.Fatalf("member invite: %v", err)
	}
	want := map[string]any{"email": "new@b.c", "role": "admin"}
	if !reflect.DeepEqual(body, want) {
		t.Errorf("invite body = %v, want %v", body, want)
	}
}

func TestMemberInviteRejectsGuest(t *testing.T) {
	var called bool
	memberTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	if err := runMember(t, "invite", "g@b.c", "--role", "guest"); err == nil {
		t.Fatal("expected guest-role error, got nil")
	}
	if called {
		t.Error("server was hit despite invalid role")
	}
}

func TestMemberInviteRejectsBadRole(t *testing.T) {
	memberTestServer(t, http.NewServeMux())
	if err := runMember(t, "invite", "x@b.c", "--role", "superuser"); err == nil {
		t.Fatal("expected invalid-role error, got nil")
	}
}

func TestMemberRemove(t *testing.T) {
	var removed bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/members/m1", func(w http.ResponseWriter, r *http.Request) {
		removed = true
		io.WriteString(w, `{}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	yesFlag = true
	if err := runMember(t, "remove", "m1"); err != nil {
		t.Fatalf("member remove: %v", err)
	}
	if !removed {
		t.Error("DELETE /apiv1/organizations/o1/members/m1 was never called")
	}
}

func TestMemberRemoveRefusesWithoutYes(t *testing.T) {
	var removed bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/members/m1", func(w http.ResponseWriter, r *http.Request) {
		removed = true
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "remove", "m1"); err == nil {
		t.Fatal("expected confirmation refusal, got nil")
	}
	if removed {
		t.Error("delete fired despite refused confirmation")
	}
}

func TestMemberSetRole(t *testing.T) {
	var body map[string]any
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("PATCH /apiv1/organizations/o1/members/m1", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode set-role body: %v", err)
		}
		io.WriteString(w, `{"id":"m1","role":"admin"}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "set-role", "m1", "admin"); err != nil {
		t.Fatalf("member set-role: %v", err)
	}
	if !reflect.DeepEqual(body, map[string]any{"role": "admin"}) {
		t.Errorf("set-role body = %v, want {role: admin}", body)
	}
}

func TestMemberSetRoleAllowsGuest(t *testing.T) {
	var body map[string]any
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("PATCH /apiv1/organizations/o1/members/m1", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode set-role body: %v", err)
		}
		io.WriteString(w, `{"id":"m1","role":"guest"}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "set-role", "m1", "guest"); err != nil {
		t.Fatalf("member set-role guest: %v", err)
	}
	if !reflect.DeepEqual(body, map[string]any{"role": "guest"}) {
		t.Errorf("set-role body = %v, want {role: guest}", body)
	}
}

func TestMemberSetRoleRejectsBadRole(t *testing.T) {
	memberTestServer(t, http.NewServeMux())
	if err := runMember(t, "set-role", "m1", "emperor"); err == nil {
		t.Fatal("expected invalid-role error, got nil")
	}
}

func TestMemberInvitesList(t *testing.T) {
	var listed bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("GET /apiv1/organizations/o1/invitations", func(w http.ResponseWriter, r *http.Request) {
		listed = true
		io.WriteString(w, `[{"id":"inv1","email":"new@b.c","role":"member","createdAt":"2026-01-01T00:00:00Z","expiresAt":"2026-01-08T00:00:00Z","inviter":{"username":"ada","email":"a@b.c"}}]`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "invites", "list"); err != nil {
		t.Fatalf("member invites list: %v", err)
	}
	if !listed {
		t.Error("GET /apiv1/organizations/o1/invitations was never called")
	}
}

func TestMemberInvitesCancel(t *testing.T) {
	var cancelled bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/invitations/inv1", func(w http.ResponseWriter, r *http.Request) {
		cancelled = true
		io.WriteString(w, `{"success":true}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	yesFlag = true
	if err := runMember(t, "invites", "cancel", "inv1"); err != nil {
		t.Fatalf("member invites cancel: %v", err)
	}
	if !cancelled {
		t.Error("DELETE /apiv1/organizations/o1/invitations/inv1 was never called")
	}
}

func TestMemberInvitesCancelRefusesWithoutYes(t *testing.T) {
	var cancelled bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("DELETE /apiv1/organizations/o1/invitations/inv1", func(w http.ResponseWriter, r *http.Request) {
		cancelled = true
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "invites", "cancel", "inv1"); err == nil {
		t.Fatal("expected confirmation refusal, got nil")
	}
	if cancelled {
		t.Error("cancel fired despite refused confirmation")
	}
}

func TestMemberInvitesResend(t *testing.T) {
	var resent bool
	mux := http.NewServeMux()
	memberServeOrgHQ(mux)
	mux.HandleFunc("POST /apiv1/organizations/o1/invitations/inv1/resend", func(w http.ResponseWriter, r *http.Request) {
		resent = true
		io.WriteString(w, `{"success":true,"message":"Invitation resent"}`)
	})
	memberTestServer(t, mux)
	t.Setenv("ORCHARD_ORG", "hq")

	if err := runMember(t, "invites", "resend", "inv1"); err != nil {
		t.Fatalf("member invites resend: %v", err)
	}
	if !resent {
		t.Error("POST /apiv1/organizations/o1/invitations/inv1/resend was never called")
	}
}

func TestInvitationList(t *testing.T) {
	var gotMethod, gotPath string
	memberTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		io.WriteString(w, `[{"id":"i1","email":"me@b.c","role":"member","expiresAt":"2026-01-08T00:00:00Z","organization":{"id":"o1","name":"HQ","slug":"hq"},"project":null,"inviter":{"username":"ada"}}]`)
	}))

	if err := runInvitation(t, "list"); err != nil {
		t.Fatalf("invitation list: %v", err)
	}
	if gotMethod != http.MethodGet || gotPath != "/apiv1/invitations/pending" {
		t.Errorf("request = %s %s, want GET /apiv1/invitations/pending", gotMethod, gotPath)
	}
}

func TestInvitationAccept(t *testing.T) {
	var accepted bool
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apiv1/invitations/by-id/i1/accept", func(w http.ResponseWriter, r *http.Request) {
		accepted = true
		io.WriteString(w, `{"id":"m1","role":"member","organization":{"id":"o1","name":"HQ"}}`)
	})
	memberTestServer(t, mux)

	if err := runInvitation(t, "accept", "i1"); err != nil {
		t.Fatalf("invitation accept: %v", err)
	}
	if !accepted {
		t.Error("POST /apiv1/invitations/by-id/i1/accept was never called")
	}
}

func TestInvitationDecline(t *testing.T) {
	var declined bool
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apiv1/invitations/by-id/i1/decline", func(w http.ResponseWriter, r *http.Request) {
		declined = true
		io.WriteString(w, `{"success":true,"message":"Invitation declined"}`)
	})
	memberTestServer(t, mux)

	if err := runInvitation(t, "decline", "i1"); err != nil {
		t.Fatalf("invitation decline: %v", err)
	}
	if !declined {
		t.Error("POST /apiv1/invitations/by-id/i1/decline was never called")
	}
}

// accept-all must loop per-id accepts: the server's accept-pending endpoint
// is list-only by design and never joins the caller to anything.
func TestInvitationAcceptAll(t *testing.T) {
	acceptedIDs := []string{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apiv1/invitations/pending", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"id":"i1","organization":{"name":"HQ"}},{"id":"i2","organization":{"name":"Lab"}}]`)
	})
	mux.HandleFunc("POST /apiv1/invitations/by-id/{id}/accept", func(w http.ResponseWriter, r *http.Request) {
		acceptedIDs = append(acceptedIDs, r.PathValue("id"))
		io.WriteString(w, `{"id":"m1","role":"member","organization":{"name":"x"}}`)
	})
	memberTestServer(t, mux)

	yesFlag = true
	if err := runInvitation(t, "accept-all"); err != nil {
		t.Fatalf("invitation accept-all: %v", err)
	}
	if !reflect.DeepEqual(acceptedIDs, []string{"i1", "i2"}) {
		t.Errorf("accepted ids = %v, want [i1 i2]", acceptedIDs)
	}
}

func TestInvitationAcceptAllEmpty(t *testing.T) {
	var acceptHit bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apiv1/invitations/pending", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[]`)
	})
	mux.HandleFunc("POST /apiv1/invitations/by-id/{id}/accept", func(w http.ResponseWriter, r *http.Request) {
		acceptHit = true
	})
	memberTestServer(t, mux)

	yesFlag = true
	if err := runInvitation(t, "accept-all"); err != nil {
		t.Fatalf("invitation accept-all (empty): %v", err)
	}
	if acceptHit {
		t.Error("accept was called despite no pending invitations")
	}
}

func TestInvitationAcceptAllPartialFailure(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apiv1/invitations/pending", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"id":"i1"},{"id":"i2"}]`)
	})
	mux.HandleFunc("POST /apiv1/invitations/by-id/i1/accept", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"message":"Invitation not found or expired."}`)
	})
	mux.HandleFunc("POST /apiv1/invitations/by-id/i2/accept", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"id":"m2","role":"member"}`)
	})
	memberTestServer(t, mux)

	yesFlag = true
	if err := runInvitation(t, "accept-all"); err == nil {
		t.Fatal("expected partial-failure error, got nil")
	}
}

func TestInvitationAcceptAllRefusesWithoutYes(t *testing.T) {
	var acceptHit bool
	mux := http.NewServeMux()
	mux.HandleFunc("GET /apiv1/invitations/pending", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `[{"id":"i1"}]`)
	})
	mux.HandleFunc("POST /apiv1/invitations/by-id/{id}/accept", func(w http.ResponseWriter, r *http.Request) {
		acceptHit = true
	})
	memberTestServer(t, mux)

	if err := runInvitation(t, "accept-all"); err == nil {
		t.Fatal("expected confirmation refusal, got nil")
	}
	if acceptHit {
		t.Error("accept fired despite refused confirmation")
	}
}
