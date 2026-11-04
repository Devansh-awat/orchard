//go:build !windows

package agentd

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	loginOutputMax = 64 << 10
	loginLifetime  = 15 * time.Minute
	loginKeep      = 10 * time.Minute
)

var cursorQuery = []byte("\x1b[6n")

type loginStartParams struct {
	Agent   string            `json:"agent"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env,omitempty"`
}

type loginStatus struct {
	LoginID   string `json:"loginId"`
	Agent     string `json:"agent"`
	State     string `json:"state"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	Output    string `json:"output"`
	StartedAt int64  `json:"startedAt"`
}

type login struct {
	id      string
	agent   string
	cmd     *exec.Cmd
	master  *os.File
	out     *tailBuffer
	started time.Time
	done    chan struct{}

	mu       sync.Mutex
	exitCode *int
	ended    time.Time
}

type logins struct {
	d    *Daemon
	mu   sync.Mutex
	byID map[string]*login
}

func newLogins(d *Daemon) *logins {
	return &logins{d: d, byID: map[string]*login{}}
}

func newLoginID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (l *login) running() bool {
	select {
	case <-l.done:
		return false
	default:
		return true
	}
}

func (l *login) status() loginStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	state := "running"
	if !l.running() {
		state = "exited"
	}
	return loginStatus{
		LoginID:   l.id,
		Agent:     l.agent,
		State:     state,
		ExitCode:  l.exitCode,
		Output:    l.out.String(),
		StartedAt: l.started.UnixMilli(),
	}
}

func (l *login) kill() {
	if l.cmd.Process != nil && l.running() {
		_ = syscall.Kill(-l.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (m *logins) Start(ctx context.Context, p loginStartParams) (loginStatus, error) {
	if len(p.Command) == 0 {
		return loginStatus{}, rpcErr(codeInvalidParams, "command is required")
	}
	base := mergeEnv(m.d.env.Get(ctx), map[string]string{"TERM": "xterm-256color", "COLUMNS": "400", "LINES": "50"})
	env := mergeEnv(base, p.Env)
	bin := lookPath(env, p.Command[0])
	if bin == "" {
		return loginStatus{}, rpcErr(codeUnavailable, "%s isn't installed on this machine", p.Command[0])
	}
	uid, gid := -1, -1
	if m.d.id.cred != nil {
		uid, gid = int(m.d.id.cred.Uid), int(m.d.id.cred.Gid)
	}
	master, slave, err := openPTY(uid, gid, 50, 400)
	if err != nil {
		return loginStatus{}, rpcErr(codeUnavailable, "%v", err)
	}
	cmd := exec.Command(bin, p.Command[1:]...)
	cmd.Env = env
	cmd.Dir = m.d.id.Home
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	m.d.id.Prepare(cmd, false)
	cmd.SysProcAttr.Setsid = true
	cmd.SysProcAttr.Setctty = true
	if err := cmd.Start(); err != nil {
		slave.Close()
		master.Close()
		return loginStatus{}, rpcErr(codeUnavailable, "couldn't start %s: %v", p.Command[0], err)
	}
	slave.Close()
	l := &login{
		id:      newLoginID(),
		agent:   p.Agent,
		cmd:     cmd,
		master:  master,
		out:     &tailBuffer{max: loginOutputMax},
		started: time.Now(),
		done:    make(chan struct{}),
	}
	m.mu.Lock()
	for id, prev := range m.byID {
		prev.kill()
		if !prev.running() && time.Since(prev.ended) > loginKeep {
			delete(m.byID, id)
		}
	}
	m.byID[l.id] = l
	m.mu.Unlock()
	go l.pump()
	go m.wait(l)
	return l.status(), nil
}

func (l *login) pump() {
	buf := make([]byte, 4096)
	for {
		n, err := l.master.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = l.out.Write(chunk)
			if bytes.Contains(chunk, cursorQuery) {
				_, _ = l.master.Write([]byte("\x1b[1;1R"))
			}
		}
		if err != nil {
			return
		}
	}
}

func (m *logins) wait(l *login) {
	timer := time.AfterFunc(loginLifetime, l.kill)
	err := l.cmd.Wait()
	timer.Stop()
	code := 0
	if err != nil {
		code = -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
	}
	l.mu.Lock()
	l.exitCode = &code
	l.ended = time.Now()
	l.mu.Unlock()
	close(l.done)
	time.Sleep(100 * time.Millisecond)
	l.master.Close()
	m.d.broadcast("agent.auth", l.status())
	go m.d.catalog.Refresh(true)
}

func (m *logins) get(id string) (*login, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.byID[id]
	if !ok {
		return nil, rpcErr(codeNotFound, "sign-in %s not found", id)
	}
	return l, nil
}

func (m *logins) Status(id string) (loginStatus, error) {
	l, err := m.get(id)
	if err != nil {
		return loginStatus{}, err
	}
	return l.status(), nil
}

func (m *logins) Input(id, text string) error {
	l, err := m.get(id)
	if err != nil {
		return err
	}
	if !l.running() {
		return rpcErr(codeConflict, "this sign-in has already finished")
	}
	if _, err := l.master.Write([]byte(text)); err != nil {
		return rpcErr(codeInternal, "write: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	if _, err := l.master.Write([]byte("\r")); err != nil {
		return rpcErr(codeInternal, "write: %v", err)
	}
	return nil
}

func (m *logins) Cancel(id string) error {
	l, err := m.get(id)
	if err != nil {
		return err
	}
	l.kill()
	return nil
}

func localCallback(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.Port() == "" {
		return nil, rpcErr(codeInvalidParams, "paste the full http://localhost address from your browser")
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return u, nil
	}
	return nil, rpcErr(codeInvalidParams, "only localhost addresses can finish a sign-in")
}

func (m *logins) Callback(ctx context.Context, id, raw string) (map[string]int, error) {
	l, err := m.get(id)
	if err != nil {
		return nil, err
	}
	if !l.running() {
		return nil, rpcErr(codeConflict, "this sign-in has already finished")
	}
	u, err := localCallback(raw)
	if err != nil {
		return nil, err
	}
	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			if _, err := localCallback(req.URL.String()); err != nil {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, rpcErr(codeInvalidParams, "%v", err)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, rpcErr(codeUnavailable, "the sign-in didn't answer: %v", err)
	}
	res.Body.Close()
	return map[string]int{"status": res.StatusCode}, nil
}
