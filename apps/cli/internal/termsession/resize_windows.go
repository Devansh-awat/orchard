//go:build windows

package termsession

import (
	"context"
	"time"

	"golang.org/x/term"
)

// Windows has no SIGWINCH; poll for size changes instead.
func watchResize(ctx context.Context, fd int, onResize func()) (stop func()) {
	t := time.NewTicker(time.Second)
	go func() {
		lastCols, lastRows, _ := term.GetSize(fd)
		for {
			select {
			case <-t.C:
				cols, rows, err := term.GetSize(fd)
				if err == nil && (cols != lastCols || rows != lastRows) {
					lastCols, lastRows = cols, rows
					onResize()
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return t.Stop
}
