package sshproxy

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func startEchoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	return ln.Addr().String()
}

func writeToken(t *testing.T, path, token string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(token), 0o600); err != nil {
		t.Fatalf("write token: %v", err)
	}
}

func startBridge(t *testing.T, target, token string) (*httptest.Server, string) {
	t.Helper()
	tokenFile := filepath.Join(t.TempDir(), "token")
	writeToken(t, tokenFile, token)
	srv := httptest.NewServer(&Bridge{Target: target, TokenFile: tokenFile, DialTimeout: 2 * time.Second})
	t.Cleanup(srv.Close)
	return srv, tokenFile
}

func dialBridge(ctx context.Context, srv *httptest.Server, path, token string) (*websocket.Conn, *http.Response, error) {
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+path, &websocket.DialOptions{HTTPHeader: header})
}

func TestBridgeHealth(t *testing.T) {
	srv, _ := startBridge(t, startEchoServer(t), "secret")
	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("get health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d, want 200", resp.StatusCode)
	}
}

func TestBridgeRejectsBadAuth(t *testing.T) {
	srv, _ := startBridge(t, startEchoServer(t), "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, token := range []string{"", "wrong", "secre", "secret-extra"} {
		_, resp, err := dialBridge(ctx, srv, "/", token)
		if err == nil {
			t.Fatalf("token %q: dial succeeded, want rejection", token)
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("token %q: response = %v, want 401", token, resp)
		}
	}
}

func TestBridgeRejectsEmptyTokenFile(t *testing.T) {
	srv, _ := startBridge(t, startEchoServer(t), "  \n")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	header := http.Header{}
	header.Set("Authorization", "Bearer ")
	_, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/", &websocket.DialOptions{HTTPHeader: header})
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("empty token file must reject everything, got err=%v resp=%v", err, resp)
	}
}

func TestBridgeUnknownPath(t *testing.T) {
	srv, _ := startBridge(t, startEchoServer(t), "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialBridge(ctx, srv, "/other", "secret")
	if err == nil || resp == nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("want 404 on unknown path, got err=%v resp=%v", err, resp)
	}
}

func TestBridgeRoundTripEcho(t *testing.T) {
	srv, _ := startBridge(t, startEchoServer(t), "secret\n")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := dialBridge(ctx, srv, "/", "secret")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	payload := []byte("SSH-2.0-OpenSSH_9.9\r\n")
	if err := conn.Write(ctx, websocket.MessageBinary, payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	var got []byte
	for len(got) < len(payload) {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("frame type = %v, want binary", typ)
		}
		got = append(got, data...)
	}
	if string(got) != string(payload) {
		t.Fatalf("echo = %q, want %q", got, payload)
	}
}

func TestBridgeRereadsTokenPerConnection(t *testing.T) {
	srv, tokenFile := startBridge(t, startEchoServer(t), "old")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := dialBridge(ctx, srv, "/", "old")
	if err != nil {
		t.Fatalf("dial with old token: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
	writeToken(t, tokenFile, "new")
	if _, resp, err := dialBridge(ctx, srv, "/", "old"); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old token after rotation: err=%v resp=%v, want 401", err, resp)
	}
	conn, _, err = dialBridge(ctx, srv, "/", "new")
	if err != nil {
		t.Fatalf("dial with rotated token: %v", err)
	}
	conn.Close(websocket.StatusNormalClosure, "")
}

func TestBridgeTargetDownIsBadGateway(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()
	srv, _ := startBridge(t, addr, "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := dialBridge(ctx, srv, "/", "secret")
	if err == nil || resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("want 502 when the target is down, got err=%v resp=%v", err, resp)
	}
}

func TestBridgeTargetCloseClosesTunnel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		_, _ = c.Write([]byte("bye"))
		c.Close()
	}()
	srv, _ := startBridge(t, ln.Addr().String(), "secret")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := dialBridge(ctx, srv, "/", "secret")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil || string(data) != "bye" {
		t.Fatalf("first read = %q, %v", data, err)
	}
	_, _, err = conn.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("after target close err = %v, want normal closure", err)
	}
}

func TestBridgeServeStopsOnCancel(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	b := &Bridge{Target: startEchoServer(t), TokenFile: filepath.Join(t.TempDir(), "missing")}
	go func() { done <- b.Serve(ctx, ln) }()
	resp, err := http.Get("http://" + ln.Addr().String() + "/health")
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	resp.Body.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve returned %v, want nil on cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not stop on cancel")
	}
}
