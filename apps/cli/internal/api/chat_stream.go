package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// StreamChat POSTs body to path as a one-shot text/event-stream request and
// delivers each SSE data payload until the server ends the stream. Unlike
// StreamSSE there is no reconnect: a chat turn is a single request. Both
// channels close when the stream ends; errs carries at most one fatal error.
func (c *Client) StreamChat(ctx context.Context, path string, body any) (<-chan json.RawMessage, <-chan error) {
	events := make(chan json.RawMessage)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		payload, err := json.Marshal(body)
		if err != nil {
			errs <- err
			return
		}
		req, err := c.newRequest(ctx, http.MethodPost, path, bytes.NewReader(payload))
		if err != nil {
			errs <- err
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")

		res, err := c.stream.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			data, _ := io.ReadAll(res.Body)
			errs <- errorFrom(res, data)
			return
		}

		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		var data strings.Builder
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if data.Len() > 0 {
					select {
					case events <- json.RawMessage(data.String()):
					case <-ctx.Done():
						return
					}
				}
				data.Reset()
			case strings.HasPrefix(line, "data:"):
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimSpace(line[5:]))
			}
		}
		if err := sc.Err(); err != nil && ctx.Err() == nil {
			errs <- err
		}
	}()

	return events, errs
}
