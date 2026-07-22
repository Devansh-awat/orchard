package api

import (
	"bufio"
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
)

// SSEFrame is one server-sent event: its id (if any) and raw JSON data.
type SSEFrame struct {
	ID   string
	Data json.RawMessage
}

// StreamSSE opens path as a text/event-stream and delivers frames until ctx
// ends, reconnecting with jittered backoff and resuming via the standard
// Last-Event-ID header. Callers that receive a terminal frame (stream-specific,
// e.g. a build-log `done` event) should cancel ctx to stop the reconnect loop.
// The error channel carries non-fatal reconnect notices; fatal HTTP errors
// (auth, 404) are delivered there too before the next retry, so callers can
// give up early. Both channels close when ctx ends.
func (c *Client) StreamSSE(ctx context.Context, path, lastEventID string) (<-chan SSEFrame, <-chan error) {
	frames := make(chan SSEFrame)
	errs := make(chan error, 1)

	go func() {
		defer close(frames)
		defer close(errs)
		last := lastEventID
		backoff := time.Second
		for {
			err := c.sseOnce(ctx, path, &last, frames, &backoff)
			if ctx.Err() != nil {
				return
			}
			select {
			case errs <- err:
			default:
			}
			delay := backoff + time.Duration(rand.Int64N(int64(backoff/2+1)))
			if backoff < 30*time.Second {
				backoff *= 2
			}
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return
			}
		}
	}()

	return frames, errs
}

func (c *Client) sseOnce(ctx context.Context, path string, lastEventID *string, frames chan<- SSEFrame, backoff *time.Duration) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	req, err := c.newRequest(streamCtx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")
	if *lastEventID != "" {
		req.Header.Set("Last-Event-ID", *lastEventID)
	}

	res, err := c.stream.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errorFrom(res, nil)
	}

	stale := time.AfterFunc(sseStaleAfter, cancel)
	defer stale.Stop()

	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var id string
	var data strings.Builder
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if data.Len() > 0 {
				stale.Reset(sseStaleAfter)
				if id != "" {
					*lastEventID = id
				}
				*backoff = time.Second
				select {
				case frames <- SSEFrame{ID: id, Data: json.RawMessage(data.String())}:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			id, data = "", strings.Builder{}
		case strings.HasPrefix(line, "id:"):
			id = strings.TrimSpace(line[3:])
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(line[5:]))
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return err
	}
	return context.Canceled
}
