package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
)

// DialExec opens the interactive pod terminal websocket
// (ws(s)://…/apiv1/pods/:pod/exec). Requires an exec-scope token; the server
// re-checks authorization every 15s and closes the shell on revocation.
func (c *Client) DialExec(ctx context.Context, pod, namespace, container string) (*websocket.Conn, error) {
	wsBase := strings.Replace(c.BaseURL, "http", "ws", 1)
	q := url.Values{}
	if namespace != "" {
		q.Set("namespace", namespace)
	}
	if container != "" {
		q.Set("container", container)
	}
	target := wsBase + "/apiv1/pods/" + url.PathEscape(pod) + "/exec"
	if len(q) > 0 {
		target += "?" + q.Encode()
	}

	header := http.Header{}
	if c.Token != "" {
		header.Set("Authorization", "Bearer "+c.Token)
	}
	conn, _, err := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	return conn, nil
}
