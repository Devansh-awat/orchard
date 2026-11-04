package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

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

var (
	buildStatePoll       = 5 * time.Second
	buildStreamFailLimit = 3
	buildStateFailLimit  = 4
)

type buildFollow struct {
	Timeout time.Duration
	Pin     api.RolloutPin
}

type buildFollower struct {
	cl         *api.Client
	id         string
	opts       buildFollow
	w          io.Writer
	offset     int64
	midLine    bool
	warnedNet  bool
	stateFails int
	watchState bool
}

// followBuildLogsSSE tails build logs until the build settles. The stream
// carries the logs; a slow poll of the build state ends the follow even when
// the stream never says so, and a stream that keeps failing is replaced by
// polling the logs so that nothing is hidden. Returns errSSEUnsupported when
// the server predates the endpoint (404 before any data) so callers can fall
// back to the polling tail.
func followBuildLogsSSE(ctx context.Context, cl *api.Client, deploymentID string, w io.Writer, opts buildFollow) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if opts.Timeout > 0 {
		var cancelDeadline context.CancelFunc
		ctx, cancelDeadline = context.WithTimeout(ctx, opts.Timeout)
		defer cancelDeadline()
	}
	f := &buildFollower{cl: cl, id: deploymentID, opts: opts, w: w, watchState: true}
	defer f.endLine()

	streamCtx, stopStream := context.WithCancel(ctx)
	defer stopStream()
	events, errs := cl.FollowBuildLogs(streamCtx, deploymentID, 0)
	sawData := false
	streamFails := 0
	polling := false
	ticker := time.NewTicker(buildStatePoll)
	defer ticker.Stop()

	for {
		select {
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			sawData = true
			streamFails = 0
			if ev.Reset {
				f.offset = 0
				fmt.Fprintln(os.Stderr, output.Dim("· new build started, restarting tail"))
			}
			if ev.Chunk != "" {
				f.offset = ev.Offset
				f.print(ev.Chunk)
			}
			if ev.Done {
				f.endLine()
				return buildDoneResult(ev.Status)
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			var apiErr *api.APIError
			if errors.As(err, &apiErr) {
				if apiErr.Status == 404 && !sawData {
					return errSSEUnsupported
				}
				if apiErr.Status >= 400 && apiErr.Status < 500 && apiErr.Status != 408 && apiErr.Status != 429 {
					return err
				}
			}
			if ctx.Err() != nil {
				continue
			}
			streamFails++
			if streamFails >= buildStreamFailLimit {
				if errors.As(err, &apiErr) {
					output.Warnf("the build log stream keeps failing (%s). Reading the logs by polling instead.", apiErr.Message)
				}
				stopStream()
				events, errs = nil, nil
				polling = true
				if done, derr := f.checkBuild(ctx, true); done {
					return derr
				}
			}
		case <-ticker.C:
			if done, derr := f.checkBuild(ctx, polling); done {
				return derr
			}
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("build still running after %s: %w", opts.Timeout, api.ErrWaitTimeout)
			}
			return ctx.Err()
		}
	}
}

func (f *buildFollower) print(chunk string) {
	fmt.Fprint(f.w, chunk)
	f.midLine = !strings.HasSuffix(chunk, "\n")
}

func (f *buildFollower) endLine() {
	if f.midLine {
		fmt.Fprintln(f.w)
		f.midLine = false
	}
}

// checkBuild reads the build state and reports whether the follow is over,
// and with what result. The logs are read when polling or when the build has
// ended, so that a stream that never delivered them hides nothing.
func (f *buildFollower) checkBuild(ctx context.Context, polling bool) (bool, error) {
	if !f.watchState && !polling {
		return false, nil
	}
	r, err := f.cl.GetRollout(ctx, f.id, f.opts.Pin, 0)
	if err != nil {
		return f.stateFailed(ctx, err, polling)
	}
	f.stateFails = 0
	ended := !buildStillRunning(r.Build.Status)
	if polling || ended {
		f.readMissedLogs(ctx)
	}
	if ended {
		f.endLine()
		return true, buildDoneResult(r.Build.Status)
	}
	return false, nil
}

func (f *buildFollower) stateFailed(ctx context.Context, err error, polling bool) (bool, error) {
	if ctx.Err() != nil {
		return false, nil
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) {
		if !f.warnedNet {
			f.warnedNet = true
			output.Warnf("cannot reach the server (%v). Still trying.", err)
		}
		return false, nil
	}
	switch {
	case apiErr.Status == 404 && !polling:
		f.watchState = false
		return false, nil
	case apiErr.Status >= 500 || apiErr.Status == 408 || apiErr.Status == 429:
		f.stateFails++
		if f.stateFails < buildStateFailLimit {
			return false, nil
		}
		return true, fmt.Errorf("cannot read the build state, the server keeps failing: %w", err)
	}
	return true, err
}

func (f *buildFollower) readMissedLogs(ctx context.Context) {
	var lr struct {
		Logs string `json:"logs"`
	}
	if err := f.cl.GetJSON(ctx, deployPath(f.id, "logs"), &lr); err != nil {
		if ctx.Err() == nil {
			output.Warnf("could not read the rest of the build logs: %v", err)
		}
		return
	}
	logs := []rune(lr.Logs)
	if int64(len(logs)) < f.offset {
		f.offset = 0
	}
	if int64(len(logs)) == f.offset {
		return
	}
	f.print(string(logs[f.offset:]))
	f.offset = int64(len(logs))
}

func buildStillRunning(status string) bool {
	switch strings.ToLower(status) {
	case "building", "pending", "queued", "scheduled":
		return true
	}
	return false
}

type buildEndedError struct {
	status string
}

func (e *buildEndedError) Error() string { return "build " + e.status }

func (e *buildEndedError) Unwrap() error {
	if e.status == "failed" {
		return api.ErrDeployFailed
	}
	return nil
}

func buildDoneResult(status string) error {
	switch strings.ToLower(status) {
	case "", "succeeded", "success", "complete", "none":
		if status != "" {
			output.Successf("build %s", status)
		}
		return nil
	}
	return &buildEndedError{status: strings.ToLower(status)}
}
