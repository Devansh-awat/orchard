package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/auth"
	"github.com/hackclub/orchard/fc-builder/internal/builds"
	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
	"github.com/hackclub/orchard/fc-builder/internal/vm"
)

type vms struct{ err error }

func (v vms) Acquire(ctx context.Context, tenant string) (*vm.VM, func(), error) {
	if v.err != nil {
		return nil, nil, v.err
	}
	return &vm.VM{ID: "vm", Tenant: tenant, Slot: netsetup.ForSlot(0)}, func() {}, nil
}

func (v vms) Dial(ctx context.Context, _ *vm.VM) (net.Conn, error) {
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		bufio.NewReader(b).ReadBytes('\n')
		enc := json.NewEncoder(b)
		enc.Encode(proto.Log("build", "#1 DONE"))
		enc.Encode(proto.Result(nil, nil))
	}()
	return a, nil
}

type grants struct{}

func (grants) Grant(int, string) (func(), error) { return func() {}, nil }

var secret = []byte("test-secret")

func server(t *testing.T, v vms) *httptest.Server {
	r, err := builds.NewRunner(t.TempDir(), "host-0", v, grants{})
	if err != nil {
		t.Fatal(err)
	}
	s := New(r, func() proto.HostStatus { return proto.HostStatus{HostID: "host-0", MaxVMs: 6} }, 5*time.Second)
	srv := httptest.NewServer(s.Handler(secret))
	t.Cleanup(srv.Close)
	return srv
}

func call(t *testing.T, method, url string, body any, authed bool) *http.Response {
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req, _ := http.NewRequest(method, url, &buf)
	if authed {
		req.Header.Set("Authorization", "Bearer "+auth.Sign(secret, time.Now(), time.Minute))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func buildReq(id string) proto.BuildRequest {
	return proto.BuildRequest{
		ID: id, DeploymentID: "d", Tenant: "t", Repository: "orchard/app",
		Source: proto.Source{Kind: proto.SourceGit, CloneURL: "https://github.com/x/y", Branch: "main"},
		Steps:  []proto.Step{{Name: "build", Script: "true"}},
	}
}

func TestRequiresAuth(t *testing.T) {
	srv := server(t, vms{})
	if resp := call(t, "GET", srv.URL+"/v1/status", nil, false); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("got %d", resp.StatusCode)
	}
	if resp := call(t, "GET", srv.URL+"/healthz", nil, false); resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz %d", resp.StatusCode)
	}
}

func TestCreateStreamsEventsThenStatus(t *testing.T) {
	srv := server(t, vms{})
	resp := call(t, "POST", srv.URL+"/v1/builds", buildReq("b1"), true)
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("got %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var types []string
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		var ev proto.Event
		json.Unmarshal(sc.Bytes(), &ev)
		types = append(types, ev.Type)
	}
	if strings.Join(types, ",") != "accepted,phase,log,result" {
		t.Fatalf("events %v", types)
	}
	var st proto.BuildStatus
	json.NewDecoder(call(t, "GET", srv.URL+"/v1/builds/b1", nil, true).Body).Decode(&st)
	if st.Status != proto.StatusSucceeded {
		t.Fatalf("status %+v", st)
	}
	again := call(t, "POST", srv.URL+"/v1/builds", buildReq("b1"), true)
	if again.StatusCode != http.StatusOK {
		t.Fatalf("idempotent re-POST got %d", again.StatusCode)
	}
}

func TestNoCapacityIs429AndUnknownIs404(t *testing.T) {
	srv := server(t, vms{err: vm.ErrNoCapacity})
	if resp := call(t, "POST", srv.URL+"/v1/builds", buildReq("b2"), true); resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("got %d", resp.StatusCode)
	}
	if resp := call(t, "GET", srv.URL+"/v1/builds/b2", nil, true); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d", resp.StatusCode)
	}
	if resp := call(t, "POST", srv.URL+"/v1/builds", proto.BuildRequest{ID: "x"}, true); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid got %d", resp.StatusCode)
	}
}
