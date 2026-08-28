package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
)

var errSSEUnsupported = errors.New("sse endpoint unavailable")

// followRuntimeLogsSSE tails pod logs over the SSE stream, prefixing lines
// with the pod name when more than one pod is active. Returns
// errSSEUnsupported when the server predates the endpoint so callers can fall
// back to the polling tail.
func followRuntimeLogsSSE(ctx context.Context, cl *api.Client, deploymentID string, tailLines int) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	events, errs := cl.FollowRuntimeLogs(ctx, deploymentID, tailLines)
	sawData := false
	pods := map[string]bool{}
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return nil
			}
			sawData = true
			if ev.Gone && ev.Pod != "" {
				delete(pods, ev.Pod)
				fmt.Fprintln(os.Stderr, output.Dim("· pod "+ev.Pod+" gone"))
				continue
			}
			if ev.Done {
				return nil
			}
			for _, l := range ev.Lines {
				pods[l.Pod] = true
				if len(pods) > 1 {
					fmt.Println(output.Dim(l.Pod) + " " + l.Line)
				} else {
					fmt.Println(l.Line)
				}
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
			return nil
		}
	}
}

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
