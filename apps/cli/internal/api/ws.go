package api

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/coder/websocket"
	"golang.org/x/term"
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
	if cols, rows, err := term.GetSize(int(os.Stdin.Fd())); err == nil && cols > 0 && rows > 0 {
		q.Set("cols", strconv.Itoa(cols))
		q.Set("rows", strconv.Itoa(rows))
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

// DialSandboxSSH opens the sandbox SSH tunnel websocket
// (ws(s)://…/apiv1/sandboxes/:id/ssh). Binary frames carry raw TCP bytes to
// the sandbox's sshd in both directions; requires an exec-scope token.
func (c *Client) DialSandboxSSH(ctx context.Context, id string) (*websocket.Conn, error) {
	wsBase := strings.Replace(c.BaseURL, "http", "ws", 1)
	target := wsBase + "/apiv1/sandboxes/" + url.PathEscape(id) + "/ssh"

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
