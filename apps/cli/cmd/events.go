package cmd

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func eventsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "events",
		GroupID: groupCore,
		Short:   "Stream live events from the org event bus",
	}
	c.AddCommand(eventsTailCmd())
	return c
}

func eventsTailCmd() *cobra.Command {
	var types, sinceID string
	c := &cobra.Command{
		Use:   "tail",
		Short: "Tail org events until interrupted (NDJSON when piped)",
		Long: "Subscribe to the org event bus (SSE) and print every event as it\n" +
			"arrives: one NDJSON line per event when piped (or with -o json), a\n" +
			"compact line in a terminal. Reconnects automatically and resumes from\n" +
			"the last seen event id. Runs until Ctrl-C.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			filter := eventsTypeFilter(types)
			jsonMode := fmtFlag() == output.FormatJSON
			events, errs := cl.SubscribeOrgEvents(cmd.Context(), orgID, sinceID)
			for {
				select {
				case ev, ok := <-events:
					if !ok {
						return nil
					}
					if filter != nil && !filter[ev.Type] {
						continue
					}
					if jsonMode {
						if err := output.NDJSON(eventsRecord(ev)); err != nil {
							return err
						}
					} else {
						fmt.Println(eventsLine(ev))
					}
				case rerr, ok := <-errs:
					if !ok {
						errs = nil
						continue
					}
					output.Warnf("event stream reconnecting: %v", rerr)
				}
			}
		},
	}
	c.Flags().StringVar(&types, "types", "", "only show these event types (comma-separated, e.g. deployment.changed,build.changed)")
	c.Flags().StringVar(&sinceID, "since-id", "", "replay events newer than this event id before going live")
	return c
}

// eventsTypeFilter parses the --types comma list; nil means no filtering.
func eventsTypeFilter(types string) map[string]bool {
	m := map[string]bool{}
	for _, t := range strings.Split(types, ",") {
		if t = strings.TrimSpace(t); t != "" {
			m[t] = true
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// eventsRecord shapes one event for NDJSON output, surfacing the SSE event id
// (which lives outside the JSON payload) as "eventId". Payload passes through
// as raw JSON.
func eventsRecord(ev api.OrgEvent) map[string]any {
	m := map[string]any{
		"eventId":        ev.EventID,
		"type":           ev.Type,
		"organizationId": ev.OrganizationID,
	}
	if ev.ID != "" {
		m["id"] = ev.ID
	}
	if ev.ProjectID != "" {
		m["projectId"] = ev.ProjectID
	}
	if ev.TS != 0 {
		m["ts"] = ev.TS
	}
	if len(ev.Payload) > 0 {
		m["payload"] = ev.Payload
	}
	return m
}

// eventsLine renders the compact terminal form: ts, type, projectId, id.
func eventsLine(ev api.OrgEvent) string {
	ts := time.Now()
	if ev.TS > 0 {
		ts = time.UnixMilli(ev.TS)
	}
	parts := []string{output.Dim(ts.Format("15:04:05")), ev.Type}
	if ev.ProjectID != "" {
		parts = append(parts, output.Dim(ev.ProjectID))
	}
	if ev.ID != "" {
		parts = append(parts, ev.ID)
	}
	return strings.Join(parts, "  ")
}

// eventsClearScreen resets the terminal between --watch renders.
const eventsClearScreen = "\x1b[2J\x1b[H"

// eventsOrgID digs the owning org out of a resource detail response:
// top-level organizationId when present, else the embedded project's
// (deployments and databases nest it there).
func eventsOrgID(raw map[string]any) string {
	if v := str(raw["organizationId"]); v != "" {
		return v
	}
	if p, ok := raw["project"].(map[string]any); ok {
		return str(p["organizationId"])
	}
	return ""
}

// eventsWatchPoll re-renders on a fixed interval until ctx ends (Ctrl-C
// exits cleanly). Used when the resource carries no org id for an SSE sub.
func eventsWatchPoll(ctx context.Context, interval time.Duration, refresh func(context.Context) error) error {
	for {
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return nil
		}
		if err := refresh(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

// eventsWatchSSE re-renders whenever a matching org event arrives, with a 30s
// poll fallback covering missed events and reconnect gaps.
func eventsWatchSSE(ctx context.Context, cl *api.Client, orgID, eventType, id string, refresh func(context.Context) error) error {
	events, errs := cl.SubscribeOrgEvents(ctx, orgID, "")
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return nil
			}
			if ev.Type != eventType || ev.ID != id {
				continue
			}
		case _, ok := <-errs:
			if !ok {
				errs = nil
			}
			continue // reconnect notice; the poll fallback covers any gap
		case <-ticker.C:
		case <-ctx.Done():
			return nil
		}
		if err := refresh(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}
