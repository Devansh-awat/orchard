package cmd

import (
	"context"
	"errors"
	"net/url"
	"strconv"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

// addWaitFlags wires --wait/--timeout onto commands that trigger async work.
func addWaitFlags(c *cobra.Command) (wait *bool, timeout *time.Duration) {
	wait = c.Flags().Bool("wait", false, "block until the operation reaches a terminal state")
	timeout = c.Flags().Duration("timeout", 10*time.Minute, "give up waiting after this long (exit 8)")
	return wait, timeout
}

// runWait polls spec with progress on stderr, honoring the command context.
func runWait(ctx context.Context, cl *api.Client, spec api.WaitSpec, timeout time.Duration) error {
	spec.Timeout = timeout
	if spec.Progress == nil {
		spec.Progress = func(status string) {
			if status != "" {
				output.Warnf("status: %s", status)
			}
		}
	}
	status, err := cl.WaitFor(ctx, spec)
	if err != nil {
		return err
	}
	output.Successf("reached %s", status)
	return nil
}

// addPageFlags wires cursor pagination onto list commands that support it.
func addPageFlags(c *cobra.Command) (limit *int, cursor *string, all *bool) {
	limit = c.Flags().Int("limit", 50, "page size")
	cursor = c.Flags().String("cursor", "", "resume from a previous nextCursor")
	all = c.Flags().Bool("all", false, "fetch every page (capped at 100 pages)")
	return limit, cursor, all
}

const maxPages = 100

// fetchPaged drains cursor-paginated endpoints (?cursor&limit). Returns the
// collected items and the nextCursor to resume from ("" when exhausted).
func fetchPaged(ctx context.Context, cl *api.Client, path string, q url.Values, limit int, cursor string, all bool) ([]map[string]any, string, error) {
	items := []map[string]any{}
	for page := 0; ; page++ {
		if page >= maxPages {
			return items, cursor, errors.New("--all hit the 100-page safety cap")
		}
		pq := url.Values{}
		for k, v := range q {
			pq[k] = v
		}
		if limit > 0 {
			pq.Set("limit", strconv.Itoa(limit))
		}
		if cursor != "" {
			pq.Set("cursor", cursor)
		}
		p := path
		if len(pq) > 0 {
			p += "?" + pq.Encode()
		}
		var raw map[string]any
		if err := cl.GetJSON(ctx, p, &raw); err != nil {
			return items, cursor, err
		}
		items = append(items, asList(raw)...)
		cursor = pick(raw, "nextCursor", "cursor", "next")
		if cursor == "" || !all {
			return items, cursor, nil
		}
	}
}
