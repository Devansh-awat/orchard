package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
)

var errSSEUnsupported = errors.New("sse endpoint unavailable")

// followBuildLogsSSE tails build logs line-by-line over the SSE stream and
// returns once the build settles. Returns errSSEUnsupported when the server
// predates the endpoint (404 before any data) so callers can fall back to the
// polling tail.
func followBuildLogsSSE(ctx context.Context, cl *api.Client, deploymentID string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	events, errs := cl.FollowBuildLogs(ctx, deploymentID, 0)
	sawData := false
	needsNewline := false
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return nil
			}
			sawData = true
			if ev.Reset {
				fmt.Fprintln(os.Stderr, output.Dim("· new build started, restarting tail"))
			}
			if ev.Chunk != "" {
				fmt.Print(ev.Chunk)
				needsNewline = !strings.HasSuffix(ev.Chunk, "\n")
			}
			if ev.Done {
				if needsNewline {
					fmt.Println()
				}
				if ev.Status != "" {
					output.Successf("build %s", ev.Status)
				}
				return nil
			}
		case err, ok := <-errs:
			if !ok {
				return nil
			}
			var apiErr *api.APIError
			if !sawData && errors.As(err, &apiErr) && apiErr.Status == 404 {
				return errSSEUnsupported
			}
		case <-ctx.Done():
			if needsNewline {
				fmt.Println()
			}
			return nil
		}
	}
}
