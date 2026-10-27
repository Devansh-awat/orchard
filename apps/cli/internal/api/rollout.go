package api

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrDeployFailed   = errors.New("deploy failed")
	ErrDeployCrashing = errors.New("deploy crashing")
)

type RolloutFailingPod struct {
	Pod       string   `json:"pod"`
	Container string   `json:"container,omitempty"`
	Reason    string   `json:"reason"`
	Message   string   `json:"message,omitempty"`
	ExitCode  *int     `json:"exitCode"`
	Restarts  int      `json:"restarts"`
	LogTail   []string `json:"logTail"`
}

type RolloutBuild struct {
	Status  string   `json:"status"`
	Step    string   `json:"step"`
	Error   string   `json:"error"`
	LogTail []string `json:"logTail"`
}

type RolloutPods struct {
	Desired int                 `json:"desired"`
	Ready   int                 `json:"ready"`
	Failing []RolloutFailingPod `json:"failing"`
}

type Rollout struct {
	Phase     string       `json:"phase"`
	Terminal  bool         `json:"terminal"`
	ReleaseID string       `json:"releaseId"`
	URL       string       `json:"url"`
	Build     RolloutBuild `json:"build"`
	Pods      RolloutPods  `json:"pods"`
	Hint      string       `json:"hint"`
}

type RolloutPin struct {
	Release string
	Since   string
}

func PinFrom(raw map[string]any) RolloutPin {
	var p RolloutPin
	if s, ok := raw["releaseId"].(string); ok {
		p.Release = s
	}
	if s, ok := raw["rolloutSince"].(string); ok {
		p.Since = s
	}
	return p
}

type RolloutError struct {
	Rollout *Rollout
	kind    error
}

func (e *RolloutError) Unwrap() error { return e.kind }

func (e *RolloutError) Error() string {
	r := e.Rollout
	switch r.Phase {
	case "build_failed":
		if first := firstLine(r.Build.Error); first != "" {
			return "build failed: " + first
		}
		return "build failed"
	case "crashing", "unhealthy":
		label := "deployment is crashing"
		if r.Phase == "unhealthy" {
			label = "deployment is unhealthy"
		}
		if len(r.Pods.Failing) > 0 {
			f := r.Pods.Failing[0]
			detail := f.Reason
			if f.ExitCode != nil {
				detail += fmt.Sprintf(", exit code %d", *f.ExitCode)
			}
			return fmt.Sprintf("%s: pod %s %s", label, f.Pod, detail)
		}
		if r.Hint != "" {
			return label + ": " + r.Hint
		}
		return label
	}
	return "rollout ended in " + r.Phase
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func RolloutPath(id string, pin RolloutPin, waitSecs int) string {
	q := url.Values{}
	if waitSecs > 0 {
		q.Set("wait", "1")
		q.Set("timeout", strconv.Itoa(waitSecs))
	}
	if pin.Release != "" {
		q.Set("release", pin.Release)
	}
	if pin.Since != "" {
		q.Set("since", pin.Since)
	}
	p := "/deployments/" + url.PathEscape(id) + "/rollout"
	if len(q) > 0 {
		p += "?" + q.Encode()
	}
	return p
}

func (c *Client) GetRollout(ctx context.Context, id string, pin RolloutPin, waitSecs int) (*Rollout, error) {
	var r Rollout
	if err := c.GetJSON(ctx, RolloutPath(id, pin, waitSecs), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func RolloutOutcome(r *Rollout) error {
	if r == nil || !r.Terminal {
		return nil
	}
	switch r.Phase {
	case "build_failed":
		return &RolloutError{Rollout: r, kind: ErrDeployFailed}
	case "crashing", "unhealthy":
		return &RolloutError{Rollout: r, kind: ErrDeployCrashing}
	}
	return nil
}

type RolloutWaitSpec struct {
	DeploymentID string
	Pin          RolloutPin
	Timeout      time.Duration
	RequestWait  time.Duration
	MinInterval  time.Duration
	Progress     func(r *Rollout)
}

func (c *Client) WaitRollout(ctx context.Context, spec RolloutWaitSpec) (*Rollout, error) {
	if spec.Timeout <= 0 {
		spec.Timeout = 10 * time.Minute
	}
	if spec.RequestWait <= 0 {
		spec.RequestWait = 45 * time.Second
	}
	if spec.MinInterval <= 0 {
		spec.MinInterval = 2 * time.Second
	}
	deadline := time.Now().Add(spec.Timeout)
	var last *Rollout
	lastPhase := ""
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return last, ErrWaitTimeout
		}
		waitFor := min(spec.RequestWait, remaining)
		secs := max(int((waitFor+time.Second-1)/time.Second), 1)
		started := time.Now()
		r, err := c.GetRollout(ctx, spec.DeploymentID, spec.Pin, secs)
		if err != nil {
			return last, err
		}
		last = r
		if r.Phase != lastPhase && spec.Progress != nil {
			spec.Progress(r)
		}
		lastPhase = r.Phase
		if r.Terminal {
			return r, RolloutOutcome(r)
		}
		if elapsed := time.Since(started); elapsed < spec.MinInterval {
			select {
			case <-time.After(spec.MinInterval - elapsed):
			case <-ctx.Done():
				return last, ctx.Err()
			}
		}
	}
}
