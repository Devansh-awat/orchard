package builds

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/eventlog"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
	"github.com/hackclub/orchard/fc-builder/internal/proxy"
	"github.com/hackclub/orchard/fc-builder/internal/vm"
)

var (
	ErrExists   = errors.New("build already exists")
	ErrNotFound = errors.New("build not found")
	validID     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

type VMs interface {
	Acquire(ctx context.Context, tenant string) (*vm.VM, func(), error)
	Dial(ctx context.Context, v *vm.VM) (net.Conn, error)
}

type Grants interface {
	Grant(slot int, repo string) (func(), error)
}

type Build struct {
	Req    proto.BuildRequest
	Log    *eventlog.Log
	cancel context.CancelFunc
	done   chan struct{}

	mu         sync.Mutex
	status     string
	err        string
	startedAt  int64
	finishedAt int64
	cancelled  bool
}

func (b *Build) Status() proto.BuildStatus {
	b.mu.Lock()
	defer b.mu.Unlock()
	return proto.BuildStatus{
		ID: b.Req.ID, DeploymentID: b.Req.DeploymentID, Tenant: b.Req.Tenant,
		Status: b.status, Error: b.err, StartedAt: b.startedAt, FinishedAt: b.finishedAt,
	}
}

func (b *Build) Done() <-chan struct{} {
	return b.done
}

type Runner struct {
	dir       string
	hostID    string
	vms       VMs
	grants    Grants
	retention time.Duration

	mu     sync.Mutex
	builds map[string]*Build
}

func NewRunner(dir, hostID string, vms VMs, grants Grants) (*Runner, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	r := &Runner{dir: dir, hostID: hostID, vms: vms, grants: grants, retention: 24 * time.Hour, builds: map[string]*Build{}}
	r.loadFinished()
	return r, nil
}

func (r *Runner) path(id string) string {
	return filepath.Join(r.dir, id+".ndjson")
}

func (r *Runner) loadFinished() {
	matches, _ := filepath.Glob(filepath.Join(r.dir, "*.ndjson"))
	for _, p := range matches {
		id := strings.TrimSuffix(filepath.Base(p), ".ndjson")
		l, err := eventlog.OpenClosed(p)
		if err != nil {
			continue
		}
		b := &Build{Req: proto.BuildRequest{ID: id}, Log: l, done: make(chan struct{}), status: proto.StatusLost}
		close(b.done)
		if meta, err := os.ReadFile(p + ".meta"); err == nil {
			json.Unmarshal(meta, &b.Req)
		}
		if st, err := os.Stat(p); err == nil {
			b.finishedAt = st.ModTime().UnixMilli()
		}
		if ev, err := eventlog.LastResult(p); err == nil && ev != nil {
			b.finishedAt = ev.At
			if ev.OK {
				b.status = proto.StatusSucceeded
			} else {
				b.status, b.err = proto.StatusFailed, ev.Error
			}
		} else {
			b.err = "builder host restarted during the build"
		}
		r.builds[id] = b
	}
}

func Validate(req proto.BuildRequest) error {
	switch {
	case !validID.MatchString(req.ID):
		return errors.New("invalid build id")
	case req.Tenant == "" || len(req.Tenant) > 128:
		return errors.New("invalid tenant")
	case !proxy.ValidRepository(req.Repository):
		return errors.New("invalid repository")
	case len(req.Steps) == 0 || len(req.Steps) > 8:
		return errors.New("a build needs 1-8 steps")
	}
	switch req.Source.Kind {
	case proto.SourceGit:
		if req.Source.CloneURL == "" || req.Source.Branch == "" {
			return errors.New("git source needs cloneUrl and branch")
		}
	case proto.SourceContext:
		if req.Source.ContextURL == "" {
			return errors.New("context source needs contextUrl")
		}
	default:
		return errors.New("unknown source kind")
	}
	return nil
}

func (r *Runner) Get(id string) (*Build, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.builds[id]
	return b, ok
}

func (r *Runner) Active() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, b := range r.builds {
		if b.Status().Status == proto.StatusRunning {
			n++
		}
	}
	return n
}

func (r *Runner) Start(ctx context.Context, req proto.BuildRequest) (*Build, error) {
	if err := Validate(req); err != nil {
		return nil, err
	}
	r.mu.Lock()
	if _, exists := r.builds[req.ID]; exists {
		r.mu.Unlock()
		return nil, ErrExists
	}
	b := &Build{Req: req, done: make(chan struct{}), status: proto.StatusRunning, startedAt: proto.Now()}
	r.builds[req.ID] = b
	r.mu.Unlock()

	fail := func(err error) (*Build, error) {
		r.mu.Lock()
		delete(r.builds, req.ID)
		r.mu.Unlock()
		return nil, err
	}
	acquireStart := time.Now()
	v, release, err := r.vms.Acquire(ctx, req.Tenant)
	if err != nil {
		return fail(err)
	}
	l, err := eventlog.Create(r.path(req.ID))
	if err != nil {
		release()
		return fail(err)
	}
	meta, _ := json.Marshal(proto.BuildRequest{ID: req.ID, DeploymentID: req.DeploymentID, Tenant: req.Tenant, Repository: req.Repository})
	os.WriteFile(r.path(req.ID)+".meta", meta, 0o600)
	b.Log = l
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(context.Background(), timeout)
	b.cancel = cancel
	l.Append(proto.Event{
		Type: proto.EventAccepted, At: proto.Now(), Data: r.hostID,
		Timings: map[string]int64{"acquireMs": time.Since(acquireStart).Milliseconds(), "vmBootMs": v.BootMs, "slot": int64(v.Slot.Index)},
	})
	l.Append(proto.Phase(proto.PhaseReady))
	go r.run(runCtx, b, v, release)
	return b, nil
}

func (r *Runner) run(ctx context.Context, b *Build, v *vm.VM, release func()) {
	result := r.execute(ctx, b, v)
	b.cancel()
	release()
	b.mu.Lock()
	if b.cancelled && !result.OK {
		result.Error = "build cancelled"
	}
	b.finishedAt = proto.Now()
	if result.OK {
		b.status = proto.StatusSucceeded
	} else {
		b.status, b.err = proto.StatusFailed, result.Error
	}
	b.mu.Unlock()
	b.Log.Append(result)
	b.Log.Close()
	close(b.done)
	log.Printf("[fc-builder] build %s (%s) finished: %s %s", b.Req.ID, b.Req.Tenant, b.Status().Status, result.Error)
}

func (r *Runner) execute(ctx context.Context, b *Build, v *vm.VM) proto.Event {
	revoke, err := r.grants.Grant(v.Slot.Index, b.Req.Repository)
	if err != nil {
		return proto.Result(err, nil)
	}
	defer revoke()
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	conn, err := r.vms.Dial(dialCtx, v)
	cancelDial()
	if err != nil {
		return proto.Result(fmt.Errorf("connect to builder VM: %w", err), nil)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	req := b.Req
	if err := json.NewEncoder(conn).Encode(proto.GuestRequest{Op: proto.OpBuild, Build: &req}); err != nil {
		return proto.Result(fmt.Errorf("send build to VM: %w", err), nil)
	}
	reader := bufio.NewReaderSize(conn, 256*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var ev proto.Event
			if jerr := json.Unmarshal(line, &ev); jerr == nil {
				if ev.Type == proto.EventResult {
					return ev
				}
				b.Log.Append(ev)
			}
		}
		if err != nil {
			switch {
			case errors.Is(ctx.Err(), context.DeadlineExceeded):
				return proto.Result(errors.New("build timed out"), nil)
			case ctx.Err() != nil:
				return proto.Result(errors.New("build cancelled"), nil)
			case errors.Is(err, io.EOF):
				return proto.Result(errors.New("builder VM closed the connection before the build finished"), nil)
			default:
				return proto.Result(fmt.Errorf("builder VM connection lost: %w", err), nil)
			}
		}
	}
}

func (r *Runner) Cancel(id string) error {
	b, ok := r.Get(id)
	if !ok {
		return ErrNotFound
	}
	b.mu.Lock()
	running := b.status == proto.StatusRunning
	if running {
		b.cancelled = true
	}
	b.mu.Unlock()
	if running && b.cancel != nil {
		b.cancel()
	}
	return nil
}

func (r *Runner) CancelDeployment(deploymentID string) int {
	r.mu.Lock()
	var ids []string
	for id, b := range r.builds {
		if b.Req.DeploymentID == deploymentID && b.Status().Status == proto.StatusRunning {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.Cancel(id)
	}
	return len(ids)
}

func (r *Runner) Prune() int {
	cutoff := time.Now().Add(-r.retention).UnixMilli()
	r.mu.Lock()
	var stale []string
	for id, b := range r.builds {
		st := b.Status()
		if st.Status != proto.StatusRunning && st.FinishedAt > 0 && st.FinishedAt < cutoff {
			stale = append(stale, id)
			delete(r.builds, id)
		}
	}
	r.mu.Unlock()
	for _, id := range stale {
		os.Remove(r.path(id))
		os.Remove(r.path(id) + ".meta")
	}
	return len(stale)
}

func (r *Runner) Wait(ctx context.Context) {
	for {
		r.mu.Lock()
		var pending []*Build
		for _, b := range r.builds {
			if b.Status().Status == proto.StatusRunning {
				pending = append(pending, b)
			}
		}
		r.mu.Unlock()
		if len(pending) == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-pending[0].done:
		}
	}
}
