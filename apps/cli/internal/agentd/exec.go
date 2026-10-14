package agentd

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os/exec"
	"syscall"
	"time"
)

const maxExecOutput = 16 << 20

type execParams struct {
	Script    string            `json:"script"`
	Stdin     string            `json:"stdin,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	TimeoutMs int               `json:"timeoutMs,omitempty"`
}

type execResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode *int   `json:"exitCode"`
	OK       bool   `json:"ok"`
	TimedOut bool   `json:"timedOut,omitempty"`
}

type capped struct {
	buf bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

func (d *Daemon) runScript(ctx context.Context, p execParams) (*execResult, error) {
	if p.Script == "" {
		return nil, rpcErr(codeInvalidParams, "script is required")
	}
	ctx, cancel := withTimeout(ctx, p.TimeoutMs, 30*time.Second)
	defer cancel()
	cmd := exec.Command(d.id.Shell, "-c", p.Script)
	cmd.Env = mergeEnv(d.env.Get(ctx), p.Env)
	cmd.Dir = d.id.Home
	if p.Cwd != "" {
		cmd.Dir = p.Cwd
	}
	if p.Stdin != "" {
		raw, err := base64.StdEncoding.DecodeString(p.Stdin)
		if err != nil {
			return nil, rpcErr(codeInvalidParams, "stdin must be base64")
		}
		cmd.Stdin = bytes.NewReader(raw)
	}
	d.id.Prepare(cmd, true)
	cmd.WaitDelay = 2 * time.Second
	stdout := &capped{max: maxExecOutput}
	stderr := &capped{max: maxExecOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, rpcErr(codeInternal, "start: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timedOut := false
	var waitErr error
	select {
	case waitErr = <-done:
	case <-ctx.Done():
		timedOut = true
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		waitErr = <-done
	}
	res := &execResult{Stdout: stdout.buf.String(), Stderr: stderr.buf.String(), TimedOut: timedOut}
	if timedOut {
		return res, rpcErr(codeInternal, "sandbox command timed out")
	}
	if cmd.ProcessState == nil {
		return nil, rpcErr(codeInternal, "wait: %v", waitErr)
	}
	var exitErr *exec.ExitError
	if waitErr != nil && !errors.As(waitErr, &exitErr) && !errors.Is(waitErr, exec.ErrWaitDelay) {
		return nil, rpcErr(codeInternal, "wait: %v", waitErr)
	}
	code := cmd.ProcessState.ExitCode()
	res.ExitCode = &code
	res.OK = code == 0
	return res, nil
}
