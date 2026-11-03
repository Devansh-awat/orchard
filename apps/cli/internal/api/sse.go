package api

import (
	"bufio"
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/url"
	"strings"
	"time"
)

// OrgEvent is one message from the org event bus
// (GET /events/orgs/:orgId, backed by Redis Streams on the server).
type OrgEvent struct {
	EventID        string          `json:"-"`
	OrganizationID string          `json:"organizationId"`
	Type           string          `json:"type"`
	ID             string          `json:"id,omitempty"`
	ProjectID      string          `json:"projectId,omitempty"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	TS             int64           `json:"ts,omitempty"`
}

// The server heartbeats every 25s; silence past this means the connection is
// dead even if the socket looks open (proxies love doing this to us).
const sseStaleAfter = 40 * time.Second

// SubscribeOrgEvents streams org events until ctx is cancelled. It reconnects
// forever with jittered backoff, resuming from the last seen event id so the
// server replays anything missed (an expired replay id just means we continue
// live: callers should treat a reconnect as "refetch what you care about").
// Heartbeats reset staleness but are not delivered. The error channel carries
// non-fatal reconnect notices; both channels close when ctx ends.
func (c *Client) SubscribeOrgEvents(ctx context.Context, orgID, lastEventID string) (<-chan OrgEvent, <-chan error) {
	events := make(chan OrgEvent)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)
		backoff := time.Second
		for {
			err := c.streamOnce(ctx, orgID, &lastEventID, events, &backoff)
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

	return events, errs
}

// streamOnce holds one SSE connection open, forwarding events until it drops
// or goes stale. On any delivered event the caller's backoff resets.
func (c *Client) streamOnce(ctx context.Context, orgID string, lastEventID *string, events chan<- OrgEvent, backoff *time.Duration) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	path := "/events/orgs/" + url.PathEscape(orgID)
	if *lastEventID != "" {
		path += "?lastEventId=" + url.QueryEscape(*lastEventID)
	}
	req, err := c.newRequest(streamCtx, "GET", path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

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
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

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
				var ev OrgEvent
				if json.Unmarshal([]byte(data.String()), &ev) == nil && ev.Type != "heartbeat" {
					ev.EventID = id
					*backoff = time.Second
					select {
					case events <- ev:
					case <-ctx.Done():
						return ctx.Err()
					}
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
