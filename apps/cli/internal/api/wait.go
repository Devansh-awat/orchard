package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var ErrWaitTimeout = errors.New("timed out waiting")

// WaitSpec polls Path until the status at Field lands in Success or Failure.
// Field supports dot paths into the JSON response ("buildStatus", "status").
type WaitSpec struct {
	Path     string
	Field    string
	Success  []string
	Failure  []string
	Interval time.Duration
	Timeout  time.Duration
	Progress func(status string)
}

// WaitFor polls until a terminal status, ErrWaitTimeout, or ctx cancellation.
// A Failure status returns a plain error naming the status (exit code 1).
func (c *Client) WaitFor(ctx context.Context, spec WaitSpec) (string, error) {
	if spec.Interval == 0 {
		spec.Interval = 3 * time.Second
	}
	if spec.Timeout == 0 {
		spec.Timeout = 10 * time.Minute
	}
	deadline := time.Now().Add(spec.Timeout)
	var last string
	for {
		var raw map[string]any
		if err := c.GetJSON(ctx, spec.Path, &raw); err != nil {
			return last, err
		}
		status, _ := dig(raw, spec.Field).(string)
		if status != last && spec.Progress != nil {
			spec.Progress(status)
		}
		last = status
		lower := strings.ToLower(status)
		if containsFold(spec.Success, lower) {
			return status, nil
		}
		if containsFold(spec.Failure, lower) {
			return status, fmt.Errorf("reached %q", status)
		}
		if time.Now().After(deadline) {
			return last, ErrWaitTimeout
		}
		select {
		case <-time.After(spec.Interval):
		case <-ctx.Done():
			return last, ctx.Err()
		}
	}
}

func containsFold(list []string, lower string) bool {
	return slices.ContainsFunc(list, func(s string) bool {
		return strings.ToLower(s) == lower
	})
}

func dig(v any, dotPath string) any {
	cur := v
	for part := range strings.SplitSeq(dotPath, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	if raw, ok := cur.(json.RawMessage); ok {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
	}
	return cur
}
