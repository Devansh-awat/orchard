package builds

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/eventlog"
	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
	"github.com/hackclub/orchard/fc-builder/internal/vm"
)

type guestScript func(req proto.BuildRequest, enc *json.Encoder, conn net.Conn)

type fakeVMs struct {
	mu       sync.Mutex
	script   guestScript
	acquired int
	released int
	err      error
}

func (f *fakeVMs) Acquire(ctx context.Context, tenant string) (*vm.VM, func(), error) {
	if f.err != nil {
		return nil, nil, f.err
	}
	f.mu.Lock()
	f.acquired++
	f.mu.Unlock()
	return &vm.VM{ID: "vm-0", Tenant: tenant, Slot: netsetup.ForSlot(0), BootMs: 1400}, func() {
		f.mu.Lock()
		f.released++
		f.mu.Unlock()
	}, nil
}

func (f *fakeVMs) Dial(ctx context.Context, v *vm.VM) (net.Conn, error) {
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		line, err := bufio.NewReader(b).ReadBytes('\n')
		if err != nil {
			return
		}
		var req proto.GuestRequest
		json.Unmarshal(line, &req)
		f.script(*req.Build, json.NewEncoder(b), b)
	}()
	return a, nil
}

type fakeGrants struct {
	mu      sync.Mutex
	granted map[string]int
}

func (g *fakeGrants) Grant(slot int, repo string) (func(), error) {
	g.mu.Lock()
	g.granted[repo]++
	g.mu.Unlock()
	return func() {
		g.mu.Lock()
		g.granted[repo]--
		g.mu.Unlock()
	}, nil
}

func request(id string) proto.BuildRequest {
	return proto.BuildRequest{
		ID: id, DeploymentID: "dep-1", Tenant: "proj-a", Repository: "orchard/app",
		Source: proto.Source{Kind: proto.SourceGit, CloneURL: "https://github.com/x/y", Branch: "main"},
		Steps:  []proto.Step{{Name: "build", Script: "true"}},
	}
}

func newRunner(t *testing.T, script guestScript) (*Runner, *fakeVMs, *fakeGrants, string) {
	dir := t.TempDir()
	v := &fakeVMs{script: script}
	g := &fakeGrants{granted: map[string]int{}}
	r, err := NewRunner(dir, "host-0", v, g)
	if err != nil {
		t.Fatal(err)
	}
	return r, v, g, dir
}

func readAll(t *testing.T, b *Build) []proto.Event {
	var buf bytes.Buffer
	if err := b.Log.Follow(context.Background(), 0, &buf, nil); err != nil {
		t.Fatal(err)
	}
	var out []proto.Event
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var ev proto.Event
		json.Unmarshal([]byte(line), &ev)
		out = append(out, ev)
	}
	return out
}

func TestSuccessfulBuildLifecycle(t *testing.T) {
	r, v, g, _ := newRunner(t, func(req proto.BuildRequest, enc *json.Encoder, _ net.Conn) {
		enc.Encode(proto.Log("build", `{"vertexes":[]}`))
		enc.Encode(proto.Result(nil, map[string]int64{"buildMs": 9000}))
	})
	b, err := r.Start(context.Background(), request("b1"))
	if err != nil {
		t.Fatal(err)
	}
	<-b.Done()
	evs := readAll(t, b)
	if evs[0].Type != proto.EventAccepted || evs[0].Data != "host-0" || evs[0].Timings["vmBootMs"] != 1400 {
		t.Fatalf("first event %+v", evs[0])
	}
	last := evs[len(evs)-1]
	if last.Type != proto.EventResult || !last.OK || last.Timings["buildMs"] != 9000 {
		t.Fatalf("last event %+v", last)
	}
	if st := b.Status(); st.Status != proto.StatusSucceeded {
		t.Fatalf("status %+v", st)
	}
	v.mu.Lock()
	released := v.released
	v.mu.Unlock()
	g.mu.Lock()
	grants := g.granted["orchard/app"]
	g.mu.Unlock()
	if released != 1 || grants != 0 {
		t.Fatalf("leaked vm=%d grants=%v", v.released, g.granted)
	}
	if _, err := r.Start(context.Background(), request("b1")); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate start: %v", err)
	}
}

func TestCancelStopsBuild(t *testing.T) {
	started := make(chan struct{})
	r, _, _, _ := newRunner(t, func(req proto.BuildRequest, enc *json.Encoder, conn net.Conn) {
		enc.Encode(proto.Log("build", "working"))
		close(started)
		bufio.NewReader(conn).ReadByte()
	})
	b, err := r.Start(context.Background(), request("b2"))
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if n := r.CancelDeployment("dep-1"); n != 1 {
		t.Fatalf("cancelled %d", n)
	}
	select {
	case <-b.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not finish build")
	}
	if st := b.Status(); st.Status != proto.StatusFailed || st.Error != "build cancelled" {
		t.Fatalf("status %+v", st)
	}
}

func TestGuestDisconnectFailsBuild(t *testing.T) {
	r, _, _, _ := newRunner(t, func(req proto.BuildRequest, enc *json.Encoder, _ net.Conn) {
		enc.Encode(proto.Log("build", "partial"))
	})
	b, _ := r.Start(context.Background(), request("b3"))
	<-b.Done()
	if st := b.Status(); st.Status != proto.StatusFailed || !strings.Contains(st.Error, "closed the connection") {
		t.Fatalf("status %+v", st)
	}
}

func TestNoCapacityLeavesNoTrace(t *testing.T) {
	r, v, _, dir := newRunner(t, nil)
	v.err = vm.ErrNoCapacity
	if _, err := r.Start(context.Background(), request("b4")); !errors.Is(err, vm.ErrNoCapacity) {
		t.Fatalf("got %v", err)
	}
	if _, ok := r.Get("b4"); ok {
		t.Fatal("failed start still registered")
	}
	if files, _ := filepath.Glob(filepath.Join(dir, "*")); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
}

func TestRestartMarksUnfinishedLost(t *testing.T) {
	dir := t.TempDir()
	l, _ := eventlog.Create(filepath.Join(dir, "gone.ndjson"))
	l.Append(proto.Log("build", "half"))
	l.Close()
	os.WriteFile(filepath.Join(dir, "gone.ndjson.meta"), []byte(`{"id":"gone","deploymentId":"dep-9","tenant":"t","repository":"orchard/x"}`), 0o600)
	l2, _ := eventlog.Create(filepath.Join(dir, "ok.ndjson"))
	l2.Append(proto.Result(nil, nil))
	l2.Close()
	r, err := NewRunner(dir, "host-0", &fakeVMs{}, &fakeGrants{granted: map[string]int{}})
	if err != nil {
		t.Fatal(err)
	}
	gone, ok := r.Get("gone")
	if !ok || gone.Status().Status != proto.StatusLost || gone.Status().DeploymentID != "dep-9" {
		t.Fatalf("gone: %+v", gone.Status())
	}
	okb, _ := r.Get("ok")
	if okb.Status().Status != proto.StatusSucceeded {
		t.Fatalf("ok: %+v", okb.Status())
	}
	if r.CancelDeployment("dep-9") != 0 {
		t.Fatal("cancelled a lost build")
	}
}

func TestValidate(t *testing.T) {
	bad := []func(*proto.BuildRequest){
		func(r *proto.BuildRequest) { r.ID = "../etc" },
		func(r *proto.BuildRequest) { r.Tenant = "" },
		func(r *proto.BuildRequest) { r.Repository = "Orchard/App" },
		func(r *proto.BuildRequest) { r.Steps = nil },
		func(r *proto.BuildRequest) { r.Source = proto.Source{Kind: "ftp"} },
		func(r *proto.BuildRequest) { r.Source = proto.Source{Kind: proto.SourceGit} },
	}
	for i, mut := range bad {
		req := request("ok-id")
		mut(&req)
		if Validate(req) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	if err := Validate(request("ok-id")); err != nil {
		t.Fatal(err)
	}
}
