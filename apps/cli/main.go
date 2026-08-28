package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/hackclub/orchard/cli/cmd"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cmd.Execute(ctx)
	stop()
	os.Exit(code)
}
