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
