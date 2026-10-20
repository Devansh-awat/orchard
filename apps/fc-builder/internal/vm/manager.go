package vm

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

var ErrNoCapacity = errors.New("no free builder VM slot")

const (
	StateBooting  = "booting"
	StateReady    = "ready"
	StateStopping = "stopping"
)

type Spec struct {
	ID         string
	Tenant     string
	Slot       netsetup.Slot
	UID        int
	CacheImage string
	VCPUs      int
	MemMiB     int
	BootArgs   string
}

type Instance interface {
	Dial(ctx context.Context, port uint32) (net.Conn, error)
	Shutdown(ctx context.Context) error
	Kill()
	Done() <-chan struct{}
}

type Launcher interface {
	Launch(ctx context.Context, spec Spec) (Instance, error)
}

type Hooks struct {
	EnsureCache  func(tenant string) (string, error)
	SetupSlot    func(slot netsetup.Slot, uid int) error
	TeardownSlot func(slot netsetup.Slot)
	HasRoom      func() bool
}

type Config struct {
	MaxVMs      int
	VCPUs       int
	MemMiB      int
	IdleTimeout time.Duration
	BootTimeout time.Duration
	AcquireWait time.Duration
	BaseUID     int
	MTU         int
	DNS         string
	Search      []string
	GCBytes     uint64
}

type VM struct {
	ID     string
	Tenant string
	Slot   netsetup.Slot

	state    string
	active   int
	lastUsed time.Time
	inst     Instance
	ready    chan struct{}
	bootErr  error
	BootedAt time.Time
	BootMs   int64
}

type Manager struct {
	cfg      Config
	launcher Launcher
	hooks    Hooks
	now      func() time.Time

	mu       sync.Mutex
	slots    []*VM
	byTenant map[string]*VM
	changed  chan struct{}
	seq      uint64
}

func NewManager(cfg Config, launcher Launcher, hooks Hooks) *Manager {
	if cfg.MaxVMs <= 0 {
		cfg.MaxVMs = 1
	}
	if cfg.BootTimeout <= 0 {
		cfg.BootTimeout = 60 * time.Second
	}
	return &Manager{
		cfg:      cfg,
		launcher: launcher,
		hooks:    hooks,
		now:      time.Now,
		slots:    make([]*VM, cfg.MaxVMs),
		byTenant: map[string]*VM{},
		changed:  make(chan struct{}),
	}
}

func (m *Manager) broadcast() {
	close(m.changed)
	m.changed = make(chan struct{})
}

func (m *Manager) Acquire(ctx context.Context, tenant string) (*VM, func(), error) {
	deadline := m.now().Add(m.cfg.AcquireWait)
	for {
		m.mu.Lock()
		if v := m.byTenant[tenant]; v != nil {
			if v.state != StateStopping {
				v.active++
				m.mu.Unlock()
				if err := m.waitReady(ctx, v); err != nil {
					m.release(v)
					return nil, nil, err
				}
				return v, m.releaser(v), nil
			}
			wait := m.changed
			m.mu.Unlock()
			if err := m.sleep(ctx, wait, deadline); err != nil {
				return nil, nil, err
			}
			continue
		}
		if i := m.freeSlot(); i >= 0 && m.hasRoom() {
			v := m.reserve(tenant, i)
			m.mu.Unlock()
			if err := m.boot(ctx, v); err != nil {
				return nil, nil, err
			}
			return v, m.releaser(v), nil
		}
		if victim := m.idleVictim(); victim != nil {
			victim.state = StateStopping
			m.mu.Unlock()
			m.stop(victim)
			continue
		}
		wait := m.changed
		m.mu.Unlock()
		if err := m.sleep(ctx, wait, deadline); err != nil {
			return nil, nil, err
		}
	}
}

func (m *Manager) sleep(ctx context.Context, wait chan struct{}, deadline time.Time) error {
	left := deadline.Sub(m.now())
	if left <= 0 {
		return ErrNoCapacity
	}
	t := time.NewTimer(min(left, time.Second))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-wait:
	case <-t.C:
	}
	return nil
}

func (m *Manager) hasRoom() bool {
	return m.hooks.HasRoom == nil || m.hooks.HasRoom()
}

func (m *Manager) freeSlot() int {
	for i, v := range m.slots {
		if v == nil {
			return i
		}
	}
	return -1
}

func (m *Manager) idleVictim() *VM {
	var victim *VM
	for _, v := range m.slots {
		if v != nil && v.state == StateReady && v.active == 0 && (victim == nil || v.lastUsed.Before(victim.lastUsed)) {
			victim = v
		}
	}
	return victim
}

func (m *Manager) reserve(tenant string, i int) *VM {
	m.seq++
	v := &VM{
		ID:     fmt.Sprintf("vm-%d-%d", i, m.seq),
		Tenant: tenant,
		Slot:   netsetup.ForSlot(i),
		state:  StateBooting,
		active: 1,
		ready:  make(chan struct{}),
	}
	m.slots[i] = v
	m.byTenant[tenant] = v
	return v
}

func (m *Manager) waitReady(ctx context.Context, v *VM) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-v.ready:
		return v.bootErr
	}
}

func (m *Manager) bootArgs(s netsetup.Slot) string {
	args := []string{
		"console=ttyS0", "reboot=k", "panic=1", "pci=off", "root=/dev/vda", "ro", "init=/init",
		"fc_ip=" + s.GuestIP.String() + "/30",
		"fc_gw=" + s.HostIP.String(),
		fmt.Sprintf("fc_mtu=%d", m.cfg.MTU),
		fmt.Sprintf("fc_gc=%d", m.cfg.GCBytes),
		fmt.Sprintf("fc_port=%d", proto.GuestPort),
	}
	if m.cfg.DNS != "" {
		args = append(args, "fc_dns="+m.cfg.DNS)
	}
	if len(m.cfg.Search) > 0 {
		args = append(args, "fc_search="+strings.Join(m.cfg.Search, ","))
	}
	return strings.Join(args, " ")
}

func (m *Manager) boot(ctx context.Context, v *VM) (err error) {
	start := m.now()
	uid := m.cfg.BaseUID + v.Slot.Index
	defer func() {
		if err != nil {
			log.Printf("[fc-builder] vm %s (%s) boot failed: %v", v.ID, v.Tenant, err)
			m.mu.Lock()
			v.bootErr = err
			m.forget(v)
			m.mu.Unlock()
			close(v.ready)
		}
	}()
	image, err := m.hooks.EnsureCache(v.Tenant)
	if err != nil {
		return fmt.Errorf("cache image: %w", err)
	}
	if err := m.hooks.SetupSlot(v.Slot, uid); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	bootCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), m.cfg.BootTimeout)
	defer cancel()
	inst, err := m.launcher.Launch(bootCtx, Spec{
		ID: v.ID, Tenant: v.Tenant, Slot: v.Slot, UID: uid, CacheImage: image,
		VCPUs: m.cfg.VCPUs, MemMiB: m.cfg.MemMiB, BootArgs: m.bootArgs(v.Slot),
	})
	if err != nil {
		m.hooks.TeardownSlot(v.Slot)
		return fmt.Errorf("launch: %w", err)
	}
	if err := Ping(bootCtx, inst); err != nil {
		inst.Kill()
		<-inst.Done()
		m.hooks.TeardownSlot(v.Slot)
		return fmt.Errorf("guest not ready: %w", err)
	}
	m.mu.Lock()
	v.inst = inst
	v.state = StateReady
	v.BootedAt = m.now()
	v.BootMs = m.now().Sub(start).Milliseconds()
	m.mu.Unlock()
	close(v.ready)
	go m.watch(v)
	log.Printf("[fc-builder] vm %s (%s) ready in %dms on slot %d", v.ID, v.Tenant, v.BootMs, v.Slot.Index)
	return nil
}

func Ping(ctx context.Context, inst Instance) error {
	var last error
	for {
		if err := ctx.Err(); err != nil {
			if last != nil {
				return last
			}
			return err
		}
		select {
		case <-inst.Done():
			return errors.New("VM exited during boot")
		default:
		}
		last = pingOnce(ctx, inst)
		if last == nil {
			return nil
		}
		t := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
		case <-t.C:
		}
		t.Stop()
	}
}

func pingOnce(ctx context.Context, inst Instance) error {
	dctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	conn, err := inst.Dial(dctx, proto.GuestPort)
	if err != nil {
		return err
	}
	defer conn.Close()
	if dl, ok := dctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if err := json.NewEncoder(conn).Encode(proto.GuestRequest{Op: proto.OpPing}); err != nil {
		return err
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return err
	}
	var ev proto.Event
	if err := json.Unmarshal(line, &ev); err != nil {
		return err
	}
	if !ev.OK {
		return fmt.Errorf("guest not ready: %s", ev.Error)
	}
	return nil
}

func (m *Manager) watch(v *VM) {
	<-v.inst.Done()
	m.mu.Lock()
	unexpected := v.state != StateStopping
	m.forget(v)
	m.mu.Unlock()
	m.hooks.TeardownSlot(v.Slot)
	if unexpected {
		log.Printf("[fc-builder] vm %s (%s) exited unexpectedly", v.ID, v.Tenant)
	}
}

func (m *Manager) forget(v *VM) {
	if m.slots[v.Slot.Index] == v {
		m.slots[v.Slot.Index] = nil
	}
	if m.byTenant[v.Tenant] == v {
		delete(m.byTenant, v.Tenant)
	}
	m.broadcast()
}

func (m *Manager) releaser(v *VM) func() {
	var once sync.Once
	return func() { once.Do(func() { m.release(v) }) }
}

func (m *Manager) release(v *VM) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v.active--
	v.lastUsed = m.now()
	m.broadcast()
}

func (m *Manager) stop(v *VM) {
	m.mu.Lock()
	inst := v.inst
	m.mu.Unlock()
	if inst == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := inst.Shutdown(ctx); err != nil {
		log.Printf("[fc-builder] vm %s graceful stop failed, killing: %v", v.ID, err)
		inst.Kill()
	}
	<-inst.Done()
	m.mu.Lock()
	m.forget(v)
	m.mu.Unlock()
}

func (m *Manager) ReapIdle() int {
	m.mu.Lock()
	var victims []*VM
	cutoff := m.now().Add(-m.cfg.IdleTimeout)
	for _, v := range m.slots {
		if v != nil && v.state == StateReady && v.active == 0 && v.lastUsed.Before(cutoff) {
			v.state = StateStopping
			victims = append(victims, v)
		}
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, v := range victims {
		wg.Add(1)
		go func() {
			defer wg.Done()
			log.Printf("[fc-builder] vm %s (%s) idle, stopping", v.ID, v.Tenant)
			m.stop(v)
		}()
	}
	wg.Wait()
	return len(victims)
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	var all []*VM
	for _, v := range m.slots {
		if v != nil && v.state != StateStopping {
			v.state = StateStopping
			all = append(all, v)
		}
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, v := range all {
		wg.Add(1)
		go func() { defer wg.Done(); m.stop(v) }()
	}
	wg.Wait()
}

func (m *Manager) Dial(ctx context.Context, v *VM) (net.Conn, error) {
	m.mu.Lock()
	inst := v.inst
	m.mu.Unlock()
	if inst == nil {
		return nil, errors.New("VM not running")
	}
	return inst.Dial(ctx, proto.GuestPort)
}

func (m *Manager) HasTenant(tenant string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byTenant[tenant] != nil
}

func (m *Manager) MaxVMs() int {
	return m.cfg.MaxVMs
}

func (m *Manager) Status() []proto.VMStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []proto.VMStatus
	for _, v := range m.slots {
		if v != nil {
			out = append(out, proto.VMStatus{Tenant: v.Tenant, Slot: v.Slot.Index, State: v.state, Active: v.active})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}
