//go:build !windows

package agentd

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

const ProtocolVersion = 1

type AgentSpec struct {
	ID      string            `json:"id"`
	Label   string            `json:"label"`
	Command []string          `json:"command"`
	Env     map[string]string `json:"env,omitempty"`
}

type acpInit struct {
	ProtocolVersion   int             `json:"protocolVersion"`
	AgentCapabilities json.RawMessage `json:"agentCapabilities,omitempty"`
	AgentInfo         json.RawMessage `json:"agentInfo,omitempty"`
	AuthMethods       json.RawMessage `json:"authMethods,omitempty"`
}

type agentCaps struct {
	LoadSession         bool `json:"loadSession"`
	SessionCapabilities struct {
		Resume *json.RawMessage `json:"resume"`
		Close  *json.RawMessage `json:"close"`
	} `json:"sessionCapabilities"`
	Meta map[string]json.RawMessage `json:"_meta"`
}

type acpSessionState struct {
	SessionID     string          `json:"sessionId,omitempty"`
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
	Models        json.RawMessage `json:"models,omitempty"`
	Modes         json.RawMessage `json:"modes,omitempty"`
}

type AgentProc struct {
	spec    AgentSpec
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	peer    *peer
	init    acpInit
	caps    agentCaps
	stderr  *tailBuffer
	exited  chan struct{}
	exitErr error
	writeMu sync.Mutex

	onUpdate  func(sessionID string, update json.RawMessage)
	onRequest func(ctx context.Context, method string, params json.RawMessage) (any, error)
}

type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	t.mu.Unlock()
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

type spawnOptions struct {
	Dir       string
	Env       []string
	OnUpdate  func(sessionID string, update json.RawMessage)
	OnRequest func(ctx context.Context, method string, params json.RawMessage) (any, error)
}

func (d *Daemon) spawnAgent(ctx context.Context, spec AgentSpec, opts spawnOptions) (*AgentProc, error) {
	if len(spec.Command) == 0 {
		return nil, rpcErr(codeInvalidParams, "agent %s has no command", spec.ID)
	}
	env := mergeEnv(opts.Env, spec.Env)
	bin := lookPath(env, spec.Command[0])
	if bin == "" {
		return nil, rpcErr(codeUnavailable, "%s isn't installed on this machine", spec.Label)
	}
	cmd := exec.Command(bin, spec.Command[1:]...)
	cmd.Env = env
	cmd.Dir = opts.Dir
	d.id.Prepare(cmd, true)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tailBuffer{max: 16 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, rpcErr(codeUnavailable, "couldn't start %s: %v", spec.Label, err)
	}
	p := &AgentProc{spec: spec, cmd: cmd, stdin: stdin, stderr: stderr, exited: make(chan struct{}), onUpdate: opts.OnUpdate, onRequest: opts.OnRequest}
	p.peer = newPeer(func(msg []byte) error {
		p.writeMu.Lock()
		defer p.writeMu.Unlock()
		if _, err := stdin.Write(append(msg, '\n')); err != nil {
			return err
		}
		return nil
	})
	go p.readLoop(stdout)
	go func() {
		p.exitErr = cmd.Wait()
		p.peer.close(errors.New(p.exitReason()))
		close(p.exited)
	}()
	initCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	params := map[string]any{
		"protocolVersion":    ProtocolVersion,
		"clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false},
		"clientInfo":         map[string]string{"name": "orchard", "title": "Orchard Greenhouse", "version": Version},
	}
	if err := p.peer.call(initCtx, "initialize", params, &p.init); err != nil {
		p.Kill()
		var re *RPCError
		if errors.As(err, &re) {
			return nil, rpcErr(codeUnavailable, "%s: %s", spec.Label, re.Message)
		}
		return nil, rpcErr(codeUnavailable, "%s didn't start: %s", spec.Label, p.failureDetail(err))
	}
	if len(p.init.AgentCapabilities) > 0 {
		_ = json.Unmarshal(p.init.AgentCapabilities, &p.caps)
	}
	return p, nil
}

func (p *AgentProc) failureDetail(err error) string {
	tail := strings.TrimSpace(p.stderr.String())
	if tail != "" {
		lines := strings.Split(tail, "\n")
		return lines[len(lines)-1]
	}
	return err.Error()
}

func (p *AgentProc) exitReason() string {
	if p.exitErr != nil {
		return p.exitErr.Error()
	}
	return "agent exited"
}

func (p *AgentProc) readLoop(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	ctx := context.Background()
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		data := append([]byte(nil), line...)
		var probe struct {
			Method string          `json:"method"`
			ID     json.RawMessage `json:"id"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(data, &probe) == nil && probe.Method == "session/update" && len(probe.ID) == 0 {
			var up struct {
				SessionID string          `json:"sessionId"`
				Update    json.RawMessage `json:"update"`
			}
			if json.Unmarshal(probe.Params, &up) == nil && p.onUpdate != nil {
				p.onUpdate(up.SessionID, up.Update)
			}
			continue
		}
		p.peer.dispatch(ctx, data, func(ctx context.Context, method string, params json.RawMessage) (any, error) {
			if p.onRequest == nil {
				return nil, rpcErr(codeMethodNotFound, "method %s not supported", method)
			}
			return p.onRequest(ctx, method, params)
		})
	}
}

func (p *AgentProc) Alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

func (p *AgentProc) Kill() {
	if p.cmd.Process != nil {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
		go func() {
			select {
			case <-p.exited:
			case <-time.After(3 * time.Second):
				_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
			}
		}()
	}
	_ = p.stdin.Close()
}

func (p *AgentProc) NewSession(ctx context.Context, cwd string, mcp []json.RawMessage) (*acpSessionState, error) {
	var out acpSessionState
	if mcp == nil {
		mcp = []json.RawMessage{}
	}
	err := p.peer.call(ctx, "session/new", map[string]any{"cwd": cwd, "mcpServers": mcp}, &out)
	if err != nil {
		return nil, err
	}
	if out.SessionID == "" {
		return nil, rpcErr(codeInternal, "%s returned no session id", p.spec.Label)
	}
	return &out, nil
}

func (p *AgentProc) Reattach(ctx context.Context, sessionID, cwd string, mcp []json.RawMessage) (*acpSessionState, bool, error) {
	if mcp == nil {
		mcp = []json.RawMessage{}
	}
	params := map[string]any{"sessionId": sessionID, "cwd": cwd, "mcpServers": mcp}
	var out acpSessionState
	if p.caps.SessionCapabilities.Resume != nil {
		if err := p.peer.call(ctx, "session/resume", params, &out); err == nil {
			out.SessionID = sessionID
			return &out, false, nil
		}
	}
	if p.caps.LoadSession {
		if err := p.peer.call(ctx, "session/load", params, &out); err != nil {
			return nil, true, err
		}
		out.SessionID = sessionID
		return &out, true, nil
	}
	return nil, false, rpcErr(codeUnavailable, "%s can't reopen an earlier chat", p.spec.Label)
}

func (p *AgentProc) Prompt(ctx context.Context, sessionID string, blocks []json.RawMessage, meta map[string]any, sent ...func()) (string, error) {
	params := map[string]any{"sessionId": sessionID, "prompt": blocks}
	if len(meta) > 0 {
		params["_meta"] = meta
	}
	var out struct {
		StopReason string `json:"stopReason"`
	}
	var after func()
	if len(sent) > 0 {
		after = sent[0]
	}
	if err := p.peer.callThen(ctx, "session/prompt", params, &out, after); err != nil {
		return "", err
	}
	if out.StopReason == "" {
		out.StopReason = "end_turn"
	}
	return out.StopReason, nil
}

func (p *AgentProc) Cancel(sessionID string) error {
	return p.peer.notify("session/cancel", map[string]string{"sessionId": sessionID})
}

func (p *AgentProc) SetConfig(ctx context.Context, sessionID, configID string, value json.RawMessage) (json.RawMessage, error) {
	var out struct {
		ConfigOptions json.RawMessage `json:"configOptions"`
	}
	err := p.peer.call(ctx, "session/set_config_option", map[string]any{"sessionId": sessionID, "configId": configID, "value": value}, &out)
	if err == nil {
		return out.ConfigOptions, nil
	}
	var re *RPCError
	if !errors.As(err, &re) || re.Code != codeMethodNotFound {
		return nil, err
	}
	var str string
	_ = json.Unmarshal(value, &str)
	switch configID {
	case "model":
		return nil, p.peer.call(ctx, "session/set_model", map[string]any{"sessionId": sessionID, "modelId": str}, nil)
	case "mode":
		return nil, p.peer.call(ctx, "session/set_mode", map[string]any{"sessionId": sessionID, "modeId": str}, nil)
	}
	return nil, err
}

func (p *AgentProc) CloseSession(ctx context.Context, sessionID string) {
	if p.caps.SessionCapabilities.Close == nil {
		return
	}
	_ = p.peer.call(ctx, "session/close", map[string]string{"sessionId": sessionID}, nil)
}

func (p *AgentProc) Steerable() bool {
	raw, ok := p.caps.Meta["fx"]
	if !ok {
		return false
	}
	var fx struct {
		Steering bool `json:"steering"`
	}
	return json.Unmarshal(raw, &fx) == nil && fx.Steering
}

func (p *AgentProc) QueuesPrompts() bool {
	raw, ok := p.caps.Meta["claudeCode"]
	if !ok {
		return false
	}
	var cc struct {
		PromptQueueing bool `json:"promptQueueing"`
	}
	return json.Unmarshal(raw, &cc) == nil && cc.PromptQueueing
}
