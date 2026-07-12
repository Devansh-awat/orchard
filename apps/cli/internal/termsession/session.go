package termsession

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"

	"github.com/coder/websocket"
	"golang.org/x/term"
)

type resizeMsg struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// Run pumps a pod-exec websocket against the local terminal: stdin bytes go up
// as text frames, binary/text frames come down to stdout, and terminal size
// changes are sent as {type:"resize"} JSON (matching PodTerminal.svelte).
// Stdin is put in raw mode when it is a TTY, so Ctrl-C reaches the remote
// shell; the session ends when the server closes or ctx is cancelled.
// The same pump backs `orchard pod shell`, `orchard db psql`, and the TUI's
// shell tab (via tea.Exec).
func Run(ctx context.Context, conn *websocket.Conn, stdin io.Reader, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "")

	if f, ok := stdin.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		old, err := term.MakeRaw(int(f.Fd()))
		if err == nil {
			defer term.Restore(int(f.Fd()), old)
		}
		sendResize(ctx, conn, int(f.Fd()))
		stopWatch := watchResize(ctx, int(f.Fd()), func() { sendResize(ctx, conn, int(f.Fd())) })
		defer stopWatch()
	}

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdin.Read(buf)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageText, buf[:n]); werr != nil {
					cancel()
					return
				}
			}
			if err != nil {
				cancel()
				return
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil || websocket.CloseStatus(err) != -1 || errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if _, err := stdout.Write(data); err != nil {
			return err
		}
	}
}

func sendResize(ctx context.Context, conn *websocket.Conn, fd int) {
	cols, rows, err := term.GetSize(fd)
	if err != nil {
		return
	}
	data, _ := json.Marshal(resizeMsg{Type: "resize", Cols: cols, Rows: rows})
	_ = conn.Write(ctx, websocket.MessageText, data)
}
