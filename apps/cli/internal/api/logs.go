package api

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
)

// BuildLogEvent is one message from the build-log SSE stream.
type BuildLogEvent struct {
	Offset int64  `json:"offset"`
	Chunk  string `json:"chunk"`
	Reset  bool   `json:"reset"`
	Done   bool   `json:"done"`
	Status string `json:"status"`
	Type   string `json:"type"`
}

// RuntimeLogLine is one pod log line from the runtime stream.
type RuntimeLogLine struct {
	Pod  string `json:"pod"`
	TS   string `json:"ts"`
	Line string `json:"line"`
}

// RuntimeLogEvent is one message from the runtime log SSE stream.
type RuntimeLogEvent struct {
	Lines  []RuntimeLogLine `json:"lines"`
	Pod    string           `json:"pod"`
	Gone   bool             `json:"gone"`
	Done   bool             `json:"done"`
	Status string           `json:"status"`
	Type   string           `json:"type"`
}

// FollowRuntimeLogs tails a deployment's pod logs live over SSE, fanned in
// across pods with server-side batching. Heartbeats are filtered. A 404 on the
// error channel before any data means the server predates the endpoint.
func (c *Client) FollowRuntimeLogs(ctx context.Context, deploymentID string, tailLines int) (<-chan RuntimeLogEvent, <-chan error) {
	path := "/observe/deployments/" + url.PathEscape(deploymentID) + "/logs/stream"
	if tailLines > 0 {
		path += "?tailLines=" + strconv.Itoa(tailLines)
	}
	frames, errs := c.StreamSSE(ctx, path, "")

	events := make(chan RuntimeLogEvent)
	go func() {
		defer close(events)
		for f := range frames {
			var ev RuntimeLogEvent
			if json.Unmarshal(f.Data, &ev) != nil {
				continue
			}
			if ev.Type == "heartbeat" {
				continue
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return events, errs
}

// FollowBuildLogs tails a deployment's build logs live over SSE from the given
// character offset. Heartbeats are filtered out. The caller should cancel ctx
// after receiving an event with Done set; the error channel surfaces
// reconnect notices and fatal HTTP errors (a 404 means the server predates the
// stream endpoint and callers should fall back to polling).
func (c *Client) FollowBuildLogs(ctx context.Context, deploymentID string, offset int64) (<-chan BuildLogEvent, <-chan error) {
	path := "/observe/deployments/" + url.PathEscape(deploymentID) + "/build-logs/stream"
	if offset > 0 {
		path += "?offset=" + strconv.FormatInt(offset, 10)
	}
	frames, errs := c.StreamSSE(ctx, path, "")

	events := make(chan BuildLogEvent)
	go func() {
		defer close(events)
		for f := range frames {
			var ev BuildLogEvent
			if json.Unmarshal(f.Data, &ev) != nil {
				continue
			}
			if ev.Type == "heartbeat" {
				continue
			}
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return events, errs
}
