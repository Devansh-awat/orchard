package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var rolloutRequestWait = 45 * time.Second

func waitRollout(ctx context.Context, cl *api.Client, id string, pin api.RolloutPin, timeout time.Duration, legacy api.WaitSpec) (*api.Rollout, error) {
	var sp *output.Spinner
	progress := func(r *api.Rollout) {
		msg := "phase: " + r.Phase
		if r.Hint != "" && !r.Terminal {
			msg += " (" + r.Hint + ")"
		}
		if sp != nil {
			sp.Update(msg)
			return
		}
		output.Warnf("%s", msg)
	}
	if output.StderrIsTTY() && fmtFlag() != output.FormatJSON {
		sp = output.NewSpinner("waiting for rollout")
	}
	r, err := cl.WaitRollout(ctx, api.RolloutWaitSpec{
		DeploymentID: id,
		Pin:          pin,
		Timeout:      timeout,
		RequestWait:  rolloutRequestWait,
		Progress:     progress,
	})
	if sp != nil {
		sp.Stop()
	}
	var apiErr *api.APIError
	if r == nil && errors.As(err, &apiErr) && apiErr.Status == 404 {
		return nil, runWait(ctx, cl, legacy, timeout)
	}
	if err != nil {
		if r != nil && errors.Is(err, api.ErrWaitTimeout) {
			output.Warnf("still %s after %s", r.Phase, timeout)
			if r.Hint != "" {
				output.Warnf("%s", r.Hint)
			}
		}
		if r != nil && (errors.Is(err, api.ErrDeployFailed) || errors.Is(err, api.ErrDeployCrashing)) {
			printRolloutFailure(r)
		}
		return r, err
	}
	switch r.Phase {
	case "live":
		if r.URL != "" {
			output.Successf("live at %s", r.URL)
		} else {
			output.Successf("live")
		}
	default:
		output.Successf("reached %s", r.Phase)
	}
	return r, nil
}

func printRolloutFailure(r *api.Rollout) {
	w := os.Stderr
	if r.Phase == "build_failed" {
		output.Errorf("build failed")
		if r.Build.Error != "" {
			fmt.Fprintln(w, indent(r.Build.Error))
		}
		if len(r.Build.LogTail) > 0 {
			fmt.Fprintln(w, output.Dim("── last build log lines"))
			for _, l := range r.Build.LogTail {
				fmt.Fprintln(w, l)
			}
		}
	} else {
		output.Errorf("deployment is %s (%d/%d ready)", r.Phase, r.Pods.Ready, r.Pods.Desired)
		for _, f := range r.Pods.Failing {
			line := "pod " + f.Pod + ": " + f.Reason
			if f.ExitCode != nil {
				line += fmt.Sprintf(", exit code %d", *f.ExitCode)
			}
			if f.Restarts > 0 {
				line += fmt.Sprintf(", %d restarts", f.Restarts)
			}
			fmt.Fprintln(w, "  "+line)
			if f.Message != "" {
				fmt.Fprintln(w, indent(f.Message))
			}
			if len(f.LogTail) > 0 {
				fmt.Fprintln(w, output.Dim("── last log lines of "+f.Pod))
				for _, l := range f.LogTail {
					fmt.Fprintln(w, l)
				}
			}
		}
	}
	if r.Hint != "" {
		output.Warnf("%s", r.Hint)
	}
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	for i, l := range lines {
		lines[i] = "    " + l
	}
	return strings.Join(lines, "\n")
}

func rolloutJSON(id string, r *api.Rollout) map[string]any {
	out := map[string]any{"deploymentId": id}
	if r == nil {
		return out
	}
	out["releaseId"] = nullable(r.ReleaseID)
	out["phase"] = r.Phase
	out["terminal"] = r.Terminal
	out["url"] = nullable(r.URL)
	out["build"] = r.Build
	out["pods"] = r.Pods
	out["hint"] = nullable(r.Hint)
	return out
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func emitRolloutJSON(id string, r *api.Rollout) error {
	if fmtFlag() != output.FormatJSON {
		return nil
	}
	return output.JSON(rolloutJSON(id, r))
}

func waitAndEmit(cmd *cobra.Command, cl *api.Client, id string, pin api.RolloutPin, timeout time.Duration, legacy api.WaitSpec) error {
	r, err := waitRollout(cmd.Context(), cl, id, pin, timeout, legacy)
	if r != nil {
		if jerr := emitRolloutJSON(id, r); jerr != nil && err == nil {
			err = jerr
		}
	}
	return err
}

func mergeRollout(raw map[string]any, r *api.Rollout) map[string]any {
	if raw == nil {
		raw = map[string]any{}
	}
	if r == nil {
		return raw
	}
	raw["rollout"] = rolloutJSON(str(raw["id"]), r)
	if r.URL != "" {
		raw["url"] = r.URL
	}
	if r.ReleaseID != "" {
		raw["releaseId"] = r.ReleaseID
	}
	return raw
}

func deployStatusCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	var release, since string
	c := &cobra.Command{
		Use:   "status <id>",
		Short: "Show whether a deployment is live, and if not, why",
		Long: "Asks the rollout endpoint for the deployment's phase: queued, building,\n" +
			"deploying, live, build_failed, crashing, unhealthy or stopped. Failures carry\n" +
			"the build error or the failing pods' reasons plus log tails. With --wait it\n" +
			"blocks until a terminal phase and exits 9 (build failed) or 10 (crashing or\n" +
			"unhealthy) on failure.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			pin := api.RolloutPin{Release: release, Since: since}
			if *wait {
				return waitAndEmit(cmd, cl, args[0], pin, *timeout, deployWaitRunning(args[0]))
			}
			r, err := cl.GetRollout(cmd.Context(), args[0], pin, 0)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(rolloutJSON(args[0], r))
			}
			pairs := [][2]string{
				{"phase", output.Status(r.Phase)},
				{"ready", fmt.Sprintf("%d/%d", r.Pods.Ready, r.Pods.Desired)},
			}
			if r.URL != "" {
				pairs = append(pairs, [2]string{"url", r.URL})
			}
			if r.ReleaseID != "" {
				pairs = append(pairs, [2]string{"release", r.ReleaseID})
			}
			if r.Build.Status != "" {
				pairs = append(pairs, [2]string{"build", r.Build.Status})
			}
			output.KV(pairs)
			if api.RolloutOutcome(r) != nil {
				printRolloutFailure(r)
			} else if r.Hint != "" {
				output.Warnf("%s", r.Hint)
			}
			return nil
		},
	}
	c.Flags().StringVar(&release, "release", "", "pin the evaluation to this release id")
	c.Flags().StringVar(&since, "since", "", "only count changes observed after this server timestamp (ISO)")
	wait, timeout = addWaitFlags(c)
	return c
}
