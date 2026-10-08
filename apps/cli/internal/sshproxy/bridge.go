package sshproxy

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type Bridge struct {
	Target      string
	TokenFile   string
	DialTimeout time.Duration
	Logf        func(format string, args ...any)
}

func (b *Bridge) logf(format string, args ...any) {
	if b.Logf != nil {
		b.Logf(format, args...)
	}
}

func (b *Bridge) authorized(r *http.Request) bool {
	data, err := os.ReadFile(b.TokenFile)
	if err != nil {
		b.logf("bridge: read token file: %v", err)
		return false
	}
	want := strings.TrimSpace(string(data))
	if want == "" {
		return false
	}
	scheme, got, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	got = strings.TrimSpace(got)
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	case "/":
		b.serveTunnel(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (b *Bridge) serveTunnel(w http.ResponseWriter, r *http.Request) {
	if !b.authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	timeout := b.DialTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	tcp, err := net.DialTimeout("tcp", b.Target, timeout)
	if err != nil {
		b.logf("bridge: dial %s: %v", b.Target, err)
		http.Error(w, "target unreachable", http.StatusBadGateway)
		return
	}
	defer tcp.Close()
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(1 << 20)
	pumpBridge(r.Context(), ws, tcp)
}

func pumpBridge(ctx context.Context, ws *websocket.Conn, tcp net.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		defer cancel()
		buf := make([]byte, 32*1024)
		for {
			n, err := tcp.Read(buf)
			if n > 0 {
				if werr := ws.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				ws.Close(websocket.StatusNormalClosure, "")
				return
			}
		}
	}()
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if _, err := tcp.Write(data); err != nil {
			break
		}
	}
	tcp.Close()
	ws.Close(websocket.StatusNormalClosure, "")
}

func (b *Bridge) ListenAndServe(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return b.Serve(ctx, ln)
}

func (b *Bridge) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{
		Handler:           b,
		ReadHeaderTimeout: 15 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutdownCtx)
			_ = srv.Close()
		case <-done:
		}
	}()
	err := srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
