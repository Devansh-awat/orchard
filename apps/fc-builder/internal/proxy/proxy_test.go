package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
)

type fakeRegistry struct {
	srv         *httptest.Server
	tokenCalls  atomic.Int32
	mu          sync.Mutex
	lastQuery   string
	lastAuth    string
	lastPath    string
}

func newFakeRegistry(t *testing.T) *fakeRegistry {
	f := &fakeRegistry{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v2/":
			w.Header().Set("Www-Authenticate", `Bearer realm="https://harbor.example/service/token",service="harbor-registry"`)
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == "/service/token":
			u, p, ok := r.BasicAuth()
			if !ok || u != "robot" || p != "pw" || r.URL.Query().Get("service") != "harbor-registry" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			f.tokenCalls.Add(1)
			io.WriteString(w, `{"token":"tok-`+r.URL.Query().Get("scope")+`","expires_in":1800}`)
		default:
			f.mu.Lock()
			f.lastQuery, f.lastAuth, f.lastPath = r.URL.RawQuery, r.Header.Get("Authorization"), r.URL.Path
			f.mu.Unlock()
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer tok-repository:") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if r.Method == http.MethodPost {
				w.Header().Set("Location", f.srv.URL+r.URL.Path+"abc?_state=x")
				w.WriteHeader(http.StatusAccepted)
				return
			}
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func guestRequest(slot int, method, target string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.RemoteAddr = netsetup.ForSlot(slot).GuestIP.String() + ":40000"
	return r
}

func TestDeniesUngrantedRepository(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	revoke, _ := p.Grant(3, "orchard/app-a")
	defer revoke()
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(3, "HEAD", "/v2/orchard/app-b/blobs/sha256:abc"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("other repo: got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(4, "HEAD", "/v2/orchard/app-a/blobs/sha256:abc"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("other slot: got %d", rec.Code)
	}
}

func TestDeniesNonGuestClients(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	p.Grant(0, "orchard/app")
	r := httptest.NewRequest("GET", "/v2/orchard/app/manifests/latest", nil)
	r.RemoteAddr = "10.244.1.5:5555"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestForwardsGrantedWithScopedToken(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	p.Grant(2, "orchard/app")
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, guestRequest(2, "PUT", "/v2/orchard/app/manifests/v1"))
		if rec.Code != http.StatusOK {
			t.Fatalf("forward: got %d", rec.Code)
		}
	}
	if f.lastAuth != "Bearer tok-repository:orchard/app:pull,push" {
		t.Fatalf("auth: %q", f.lastAuth)
	}
	if n := f.tokenCalls.Load(); n != 1 {
		t.Fatalf("token cached? calls=%d", n)
	}
}

func TestStripsCrossRepoMountFromUngranted(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	p.Grant(1, "orchard/app")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(1, "POST", "/v2/orchard/app/blobs/uploads/?mount=sha256:aa&from=orchard/victim"))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("got %d", rec.Code)
	}
	if strings.Contains(f.lastQuery, "mount") || strings.Contains(f.lastQuery, "victim") {
		t.Fatalf("mount not stripped: %q", f.lastQuery)
	}
	if loc := rec.Header().Get("Location"); !strings.HasPrefix(loc, "/v2/orchard/app/blobs/uploads/abc") {
		t.Fatalf("location not rewritten: %q", loc)
	}
}

func TestKeepsMountWithinGrant(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	p.Grant(1, "orchard/app")
	p.Grant(1, "orchard/app-worker")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(1, "POST", "/v2/orchard/app/blobs/uploads/?mount=sha256:aa&from=orchard/app-worker"))
	if !strings.Contains(f.lastQuery, "mount=sha256") {
		t.Fatalf("legit mount stripped: %q", f.lastQuery)
	}
}

func TestRevokeRemovesAccess(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	revoke, _ := p.Grant(5, "orchard/app")
	revoke()
	revoke()
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(5, "HEAD", "/v2/orchard/app/blobs/sha256:abc"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d after revoke", rec.Code)
	}
}

func TestRejectsWeirdPaths(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	p.Grant(0, "orchard/app")
	for _, path := range []string{"/v2/_catalog", "/v2/orchard/app/../victim/manifests/x", "/service/token", "/api/v2.0/projects"} {
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, guestRequest(0, "GET", path))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: got %d", path, rec.Code)
		}
	}
}

func TestV2BaseNeedsNoCredentials(t *testing.T) {
	f := newFakeRegistry(t)
	p, _ := New(f.srv.URL, "robot", "pw")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, guestRequest(0, "GET", "/v2/"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
}
