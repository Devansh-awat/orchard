//go:build !windows

package termsession

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

func watchResize(ctx context.Context, _ int, onResize func()) (stop func()) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGWINCH)
	go func() {
		for {
			select {
			case <-ch:
				onResize()
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() { signal.Stop(ch) }
}
