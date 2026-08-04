package sshproxy

import (
	"context"
	"errors"
	"io"
	"sync/atomic"

	"github.com/coder/websocket"
)

// Pipe pumps raw bytes between stdio and a sandbox SSH tunnel websocket:
// stdin goes up as binary frames, incoming binary frames go to stdout. It is
// a dumb byte pump for ssh ProxyCommand use — no TTY, no resize, no text
// frames. stdin EOF closes the tunnel normally; a normal server close (or
// ctx cancellation) returns nil, anything else returns the error.
func Pipe(ctx context.Context, conn *websocket.Conn, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "")

	var stdinDone atomic.Bool
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdin.Read(buf)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				stdinDone.Store(true)
				conn.Close(websocket.StatusNormalClosure, "")
				return
			}
		}
	}()

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil || stdinDone.Load() || errors.Is(err, io.EOF) {
				return nil
			}
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return nil
			}
			return err
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if _, err := stdout.Write(data); err != nil {
			return err
		}
	}
}
