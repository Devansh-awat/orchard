package cmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

// addWaitFlags wires --wait/--timeout onto commands that trigger async work.
func addWaitFlags(c *cobra.Command) (wait *bool, timeout *time.Duration) {
	wait = c.Flags().Bool("wait", false, "block until the operation reaches a terminal state")
	timeout = c.Flags().Duration("timeout", 10*time.Minute, "give up waiting after this long (exit 8)")
	return wait, timeout
}

// runWait polls spec with progress on stderr, honoring the command context.
// Interactive terminals get an animated spinner; non-TTY runs keep plain
// one-line-per-transition output.
func runWait(ctx context.Context, cl *api.Client, spec api.WaitSpec, timeout time.Duration) error {
	spec.Timeout = timeout
	var sp *output.Spinner
	if spec.Progress == nil {
		if output.StderrIsTTY() && fmtFlag() != output.FormatJSON {
			sp = output.NewSpinner("waiting")
			spec.Progress = func(status string) {
				if status != "" {
					sp.Update("status: " + status)
				}
			}
		} else {
			spec.Progress = func(status string) {
				if status != "" {
					output.Warnf("status: %s", status)
				}
			}
		}
	}
	status, err := cl.WaitFor(ctx, spec)
	if sp != nil {
		sp.Stop()
	}
	if err != nil {
		return err
	}
	output.Successf("reached %s", status)
	return nil
}

// firstIngressHost returns the first ingress host attached to a deployment
// payload, or "".
// firstIngressURL prefers the URL the API computed, because a self-hosted
// instance may serve on ports other than 80 and 443 and the hostname alone
// does not say so. The https://<host> fallback is for servers that predate it.
func firstIngressURL(raw map[string]any) string {
	ings, _ := raw["ingresses"].([]any)
	for _, e := range ings {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		if u := str(m["url"]); u != "" {
			return u
		}
		if h := str(m["host"]); h != "" {
			return "https://" + h
		}
	}
	return ""
}

func firstIngressHost(raw map[string]any) string {
	ings, _ := raw["ingresses"].([]any)
	for _, e := range ings {
		if m, ok := e.(map[string]any); ok {
			if h := str(m["host"]); h != "" {
				return h
			}
		}
	}
	return ""
}

// orgSlugOf digs the organization slug out of a deployment payload that
// includes project.organization.
func orgSlugOf(raw map[string]any) string {
	if p, ok := raw["project"].(map[string]any); ok {
		if o, ok := p["organization"].(map[string]any); ok {
			return str(o["slug"])
		}
	}
	return ""
}

// printDeploySuccess fetches the deployment and prints the live URL plus
// follow-up pointers after a successful create/rebuild wait. Best-effort:
// failures here never fail the command.
func printDeploySuccess(ctx context.Context, cl *api.Client, apiURL, id string) {
	printDeployDetails(ctx, cl, apiURL, id, true)
}

func printDeployFollowUp(ctx context.Context, cl *api.Client, apiURL, id string, r *api.Rollout) {
	printDeployDetails(ctx, cl, apiURL, id, r == nil)
}

func printDeployDetails(ctx context.Context, cl *api.Client, apiURL, id string, withURL bool) {
	var raw map[string]any
	if err := cl.GetJSON(ctx, deployPath(id), &raw); err != nil {
		return
	}
	if target := firstIngressURL(raw); target != "" && withURL {
		output.Successf("live at %s", target)
	}
	if slug := orgSlugOf(raw); slug != "" {
		fmt.Fprintln(os.Stderr, "  "+output.Dim("dashboard")+"  "+strings.TrimRight(apiURL, "/")+"/"+slug+"/deployments/"+str(raw["id"]))
	}
	fmt.Fprintln(os.Stderr, "  "+output.Dim("logs")+"       orchard deploy logs "+str(raw["id"])+" -f")
}

// addPageFlags wires cursor pagination onto list commands that support it.
func addPageFlags(c *cobra.Command) (limit *int, cursor *string, all *bool) {
	limit = c.Flags().Int("limit", 50, "page size")
	cursor = c.Flags().String("cursor", "", "resume from a previous nextCursor")
	all = c.Flags().Bool("all", false, "fetch every page (capped at 100 pages)")
	return limit, cursor, all
}

// followLines polls fetch and writes only newly-appended lines: the log
// endpoints are one-shot tails, so "follow" means refetch + overlap diff
// (same approach as the web UI). Approximate under very fast rotation.
func followLines(ctx context.Context, interval time.Duration, fetch func(context.Context) (string, error), w io.Writer) error {
	prev := ""
	first := true
	for {
		cur, err := fetch(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		delta := cur
		if !first {
			delta = diffAppend(prev, cur)
		}
		if delta != "" {
			if _, werr := io.WriteString(w, strings.TrimSuffix(delta, "\n")+"\n"); werr != nil {
				return werr
			}
		}
		prev, first = cur, false
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return nil
		}
	}
}

// diffAppend returns the part of cur that follows prev: fast path when prev is
// a literal prefix (growing log), otherwise anchored on the last lines of prev
// (tail window slid forward). No anchor at all means the stream rotated; emit
// cur whole rather than dropping it.
func diffAppend(prev, cur string) string {
	if prev == "" || prev == cur {
		if prev == cur {
			return ""
		}
		return cur
	}
	if strings.HasPrefix(cur, prev) {
		return cur[len(prev):]
	}
	lines := strings.Split(strings.TrimSuffix(prev, "\n"), "\n")
	for anchor := 3; anchor >= 1; anchor-- {
		if len(lines) < anchor {
			continue
		}
		block := strings.Join(lines[len(lines)-anchor:], "\n")
		if block == "" {
			continue
		}
		if i := strings.LastIndex(cur, block); i >= 0 {
			return strings.TrimPrefix(cur[i+len(block):], "\n")
		}
	}
	return cur
}

// parseKVArgs turns KEY=VAL command arguments into a map.
func parseKVArgs(args []string) (map[string]string, error) {
	out := map[string]string{}
	for _, a := range args {
		k, v, ok := strings.Cut(a, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("expected KEY=VAL, got %q", a)
		}
		out[k] = v
	}
	return out, nil
}

// parseEnvFile reads dotenv-style lines (KEY=VAL, # comments, blanks, optional
// surrounding quotes on values).
func parseEnvFile(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for line := range strings.Lines(string(data)) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(k) == "" {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		out[strings.TrimSpace(k)] = v
	}
	return out, nil
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
