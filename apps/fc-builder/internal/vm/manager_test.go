package vm

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

type fakeInstance struct {
	done     chan struct{}
	once     sync.Once
	shutdown atomic.Int32
}

func (f *fakeInstance) Dial(ctx context.Context, port uint32) (net.Conn, error) {
	select {
	case <-f.done:
		return nil, errors.New("gone")
	default:
	}
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		line, err := bufio.NewReader(b).ReadBytes('\n')
		if err != nil {
			return
		}
		var req proto.GuestRequest
		json.Unmarshal(line, &req)
		json.NewEncoder(b).Encode(proto.Event{Type: proto.EventResult, OK: true})
	}()
	return a, nil
}

func (f *fakeInstance) Shutdown(ctx context.Context) error {
	f.shutdown.Add(1)
	f.Kill()
	return nil
}

func (f *fakeInstance) Kill()                 { f.once.Do(func() { close(f.done) }) }
func (f *fakeInstance) Done() <-chan struct{} { return f.done }

type fakeLauncher struct {
	mu        sync.Mutex
	launched  []Spec
	instances []*fakeInstance
	fail      error
	delay     time.Duration
}

func (l *fakeLauncher) Launch(ctx context.Context, spec Spec) (Instance, error) {
	time.Sleep(l.delay)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.fail != nil {
		return nil, l.fail
	}
	inst := &fakeInstance{done: make(chan struct{})}
	l.launched = append(l.launched, spec)
	l.instances = append(l.instances, inst)
	return inst, nil
}

func (l *fakeLauncher) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.launched)
}

func newTestManager(maxVMs int, l *fakeLauncher) (*Manager, *atomic.Int32) {
	var teardowns atomic.Int32
	m := NewManager(Config{
		MaxVMs: maxVMs, VCPUs: 2, MemMiB: 512, IdleTimeout: time.Minute,
		BootTimeout: 2 * time.Second, AcquireWait: 200 * time.Millisecond, BaseUID: 200000, MTU: 1280,
		DNS: "10.96.0.10", Search: []string{"svc.cluster.local"}, GCBytes: 1 << 30,
	}, l, Hooks{
		EnsureCache:  func(t string) (string, error) { return "/state/cache/" + t + ".ext4", nil },
		SetupSlot:    func(netsetup.Slot, int) error { return nil },
		TeardownSlot: func(netsetup.Slot) { teardowns.Add(1) },
	})
	return m, &teardowns
}

func TestConcurrentAcquiresShareOneVM(t *testing.T) {
	l := &fakeLauncher{delay: 50 * time.Millisecond}
	m, _ := newTestManager(4, l)
	var wg sync.WaitGroup
	vms := make([]*VM, 5)
	for i := range vms {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, release, err := m.Acquire(context.Background(), "proj-a")
			if err != nil {
				t.Error(err)
				return
			}
			vms[i] = v
			defer release()
		}()
	}
	wg.Wait()
	if n := l.count(); n != 1 {
		t.Fatalf("launched %d VMs for one tenant", n)
	}
	for _, v := range vms[1:] {
		if v != vms[0] {
			t.Fatal("tenant got different VMs")
		}
	}
}

func TestBootArgsAndUID(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(4, l)
	_, release, err := m.Acquire(context.Background(), "proj-a")
	if err != nil {
		t.Fatal(err)
	}
	release()
	spec := l.launched[0]
	if spec.UID != 200000 || spec.Slot.Index != 0 || spec.CacheImage != "/state/cache/proj-a.ext4" {
		t.Fatalf("spec %+v", spec)
	}
	for _, want := range []string{"fc_ip=172.16.0.2/30", "fc_gw=172.16.0.1", "fc_mtu=1280", "fc_dns=10.96.0.10", "init=/init"} {
		if !contains(spec.BootArgs, want) {
			t.Errorf("boot args missing %q: %s", want, spec.BootArgs)
		}
	}
}

func TestNoCapacityWhenAllBusy(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(1, l)
	_, release, err := m.Acquire(context.Background(), "proj-a")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, _, err := m.Acquire(context.Background(), "proj-b"); !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("got %v", err)
	}
}

func TestNoRoomRefusesNewTenantsButReusesRunningVMs(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(4, l)
	var room atomic.Bool
	room.Store(true)
	m.hooks.HasRoom = room.Load
	_, release, err := m.Acquire(context.Background(), "proj-a")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	room.Store(false)
	if _, _, err := m.Acquire(context.Background(), "proj-b"); !errors.Is(err, ErrNoCapacity) {
		t.Fatalf("got %v", err)
	}
	_, release2, err := m.Acquire(context.Background(), "proj-a")
	if err != nil {
		t.Fatalf("running VM refused: %v", err)
	}
	release2()
	if n := l.count(); n != 1 {
		t.Fatalf("launched %d VMs", n)
	}
}

func TestNoRoomStopsIdleVMToMakeRoom(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(4, l)
	m.hooks.HasRoom = func() bool { return len(m.byTenant) == 0 }
	_, release, _ := m.Acquire(context.Background(), "proj-a")
	release()
	v, release2, err := m.Acquire(context.Background(), "proj-b")
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	if v.Tenant != "proj-b" || m.HasTenant("proj-a") {
		t.Fatal("idle VM not stopped to make room")
	}
}

func TestEvictsIdleLRUForNewTenant(t *testing.T) {
	l := &fakeLauncher{}
	m, teardowns := newTestManager(1, l)
	_, release, _ := m.Acquire(context.Background(), "proj-a")
	release()
	v, release2, err := m.Acquire(context.Background(), "proj-b")
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	if v.Tenant != "proj-b" || m.HasTenant("proj-a") {
		t.Fatal("idle VM not replaced")
	}
	if l.instances[0].shutdown.Load() != 1 {
		t.Fatal("idle VM not shut down gracefully")
	}
	waitFor(t, func() bool { return teardowns.Load() >= 1 })
}

func TestReapIdle(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(2, l)
	now := time.Now()
	m.now = func() time.Time { return now }
	_, release, _ := m.Acquire(context.Background(), "proj-a")
	release()
	if n := m.ReapIdle(); n != 0 {
		t.Fatalf("reaped fresh VM")
	}
	now = now.Add(2 * time.Minute)
	if n := m.ReapIdle(); n != 1 || m.HasTenant("proj-a") {
		t.Fatalf("idle VM not reaped (%d)", n)
	}
}

func TestBootFailureFreesSlot(t *testing.T) {
	l := &fakeLauncher{fail: errors.New("kvm missing")}
	m, _ := newTestManager(1, l)
	if _, _, err := m.Acquire(context.Background(), "proj-a"); err == nil {
		t.Fatal("expected boot error")
	}
	l.fail = nil
	if _, release, err := m.Acquire(context.Background(), "proj-b"); err != nil {
		t.Fatalf("slot leaked: %v", err)
	} else {
		release()
	}
}

func TestUnexpectedExitFreesSlot(t *testing.T) {
	l := &fakeLauncher{}
	m, _ := newTestManager(1, l)
	_, release, _ := m.Acquire(context.Background(), "proj-a")
	release()
	l.instances[0].Kill()
	waitFor(t, func() bool { return !m.HasTenant("proj-a") })
	if len(m.Status()) != 0 {
		t.Fatal("status still lists dead VM")
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestCgroupArgsLeaveRoomForHostPageCache(t *testing.T) {
	l := &FirecrackerLauncher{CgroupBase: "kubepods/pod1/ctr/vms"}
	args := strings.Join(l.cgroupArgs(Spec{VCPUs: 8, MemMiB: 12288}), " ")
	for _, want := range []string{
		"--parent-cgroup kubepods/pod1/ctr/vms",
		"cpu.max=800000 100000",
		fmt.Sprintf("memory.high=%d", int64(12288+768)<<20),
		fmt.Sprintf("memory.max=%d", int64(12288+1536)<<20),
	} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
}
