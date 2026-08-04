package sshproxy

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dialTestServer(t *testing.T, handler http.HandlerFunc) (*websocket.Conn, context.Context) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn, ctx
}

type signalWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
	got chan struct{}
}

func (w *signalWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	n, err := w.buf.Write(p)
	w.mu.Unlock()
	select {
	case w.got <- struct{}{}:
	default:
	}
	return n, err
}

func (w *signalWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

func TestPipeEchoesBothDirectionsAndClosesOnEOF(t *testing.T) {
	closeStatus := make(chan websocket.StatusCode, 1)
	conn, ctx := dialTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		sc, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer sc.Close(websocket.StatusInternalError, "")
		for {
			typ, data, err := sc.Read(r.Context())
			if err != nil {
				closeStatus <- websocket.CloseStatus(err)
				return
			}
			if typ != websocket.MessageBinary {
				continue
			}
			if err := sc.Write(r.Context(), websocket.MessageBinary, data); err != nil {
				return
			}
		}
	})

	stdinR, stdinW := io.Pipe()
	stdout := &signalWriter{got: make(chan struct{}, 1)}
	done := make(chan error, 1)
	go func() { done <- Pipe(ctx, conn, stdinR, stdout) }()

	if _, err := io.WriteString(stdinW, "SSH-2.0-handshake bytes"); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
	select {
	case <-stdout.got:
	case <-time.After(5 * time.Second):
		t.Fatal("echo never arrived on stdout")
	}
	stdinW.Close()

	if err := <-done; err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if got := stdout.String(); got != "SSH-2.0-handshake bytes" {
		t.Errorf("stdout = %q, want the echoed bytes", got)
	}
	select {
	case status := <-closeStatus:
		if status != websocket.StatusNormalClosure {
			t.Errorf("server saw close status %v, want normal closure on stdin EOF", status)
		}
	case <-time.After(5 * time.Second):
		t.Error("server never saw the close")
	}
}

func TestPipeServerNormalCloseReturnsNil(t *testing.T) {
	conn, ctx := dialTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		sc, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		_ = sc.Write(r.Context(), websocket.MessageBinary, []byte("hello"))
		sc.Close(websocket.StatusNormalClosure, "")
	})

	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	var stdout bytes.Buffer
	if err := Pipe(ctx, conn, stdinR, &stdout); err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if got := stdout.String(); got != "hello" {
		t.Errorf("stdout = %q, want the server bytes", got)
	}
}

func TestPipeAbnormalCloseReturnsError(t *testing.T) {
	conn, ctx := dialTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		sc, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		sc.Close(websocket.StatusCode(4401), "token revoked")
	})

	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	var stdout bytes.Buffer
	err := Pipe(ctx, conn, stdinR, &stdout)
	if websocket.CloseStatus(err) != websocket.StatusCode(4401) {
		t.Fatalf("pipe error = %v, want the 4401 close status", err)
	}
}
