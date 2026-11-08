package cmd

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

type doctorCheck struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Evidence string `json:"evidence"`
	Fix      string `json:"fix"`
	Docs     string `json:"docs"`
}

type doctorSelfTest struct {
	ID         string        `json:"id"`
	Status     string        `json:"status"`
	Phase      string        `json:"phase"`
	FinishedAt *string       `json:"finishedAt"`
	Checks     []doctorCheck `json:"checks"`
	Notes      []string      `json:"notes"`
	Error      *string       `json:"error"`
	Leftovers  []string      `json:"leftovers"`
}

type doctorReport struct {
	GeneratedAt string          `json:"generatedAt"`
	Summary     map[string]int  `json:"summary"`
	Checks      []doctorCheck   `json:"checks"`
	Selftest    *doctorSelfTest `json:"selftest"`
}

var doctorPollInterval = 3 * time.Second

func doctorCmd() *cobra.Command {
	var selftest bool
	var timeout time.Duration
	c := &cobra.Command{
		Use:     "doctor",
		GroupID: groupResources,
		Short:   "Check the instance's isolation and security configuration (superadmin)",
		Long: "doctor reads the instance's own configuration and cluster state and reports whether\n" +
			"tenant isolation holds: CNI, default-deny coverage, sandbox runtimes, admission\n" +
			"policies, secrets, quotas and more. Every check is pass, warn, fail or unknown.\n\n" +
			"--selftest also runs the active isolation self-test: it creates two temporary\n" +
			"tenant namespaces on the cluster, starts probe pods and tries to reach the API\n" +
			"server, nodes, metadata address, platform services, ingress controller debug\n" +
			"ports and another tenant. Everything it creates is deleted afterwards.\n\n" +
			"Exits with code 11 when any check fails.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			var report doctorReport
			if err := cl.GetJSON(ctx, "/admin/doctor", &report); err != nil {
				return err
			}
			if selftest {
				if err := output.Confirm("Run the isolation self-test? It creates two temporary namespaces and pods in the cluster.", yesFlag); err != nil {
					return err
				}
				run, err := runDoctorSelfTest(ctx, func(path string, post bool, out any) error {
					method := http.MethodGet
					if post {
						method = http.MethodPost
					}
					return cl.Send(ctx, method, path, nil, out)
				}, timeout, doctorPollInterval)
				if err != nil {
					return err
				}
				report.Selftest = run
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(report); err != nil {
					return err
				}
			} else {
				renderDoctor(report)
			}
			if doctorFailures(report) > 0 {
				return exitcode.ErrChecksFailed
			}
			return nil
		},
	}
	c.Flags().BoolVar(&selftest, "selftest", false, "also run the active isolation self-test (creates temporary namespaces and pods)")
	c.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "how long to wait for the self-test to finish")
	return c
}

type doctorSender func(path string, post bool, out any) error

func runDoctorSelfTest(ctx context.Context, send doctorSender, timeout, poll time.Duration) (*doctorSelfTest, error) {
	var run doctorSelfTest
	if err := send("/admin/doctor/selftest", true, &run); err != nil {
		return nil, err
	}
	if run.ID == "" {
		return nil, fmt.Errorf("the server did not return a self-test id")
	}
	deadline := time.Now().Add(timeout)
	path := "/admin/doctor/selftest/" + url.PathEscape(run.ID)
	for run.Status == "running" {
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("self-test %s did not finish within %s; the server cleans it up on its own", output.SanitizeLine(run.ID), timeout)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(poll):
		}
		var next doctorSelfTest
		if err := send(path, false, &next); err != nil {
			return nil, err
		}
		run = next
	}
	return &run, nil
}

func doctorFailures(r doctorReport) int {
	n := 0
	for _, c := range r.Checks {
		if c.Status == "fail" {
			n++
		}
	}
	if r.Selftest != nil {
		for _, c := range r.Selftest.Checks {
			if c.Status == "fail" {
				n++
			}
		}
		if r.Selftest.Status == "error" {
			n++
		}
	}
	return n
}

func doctorStatus(s string) string {
	s = output.SanitizeLine(s)
	switch s {
	case "pass":
		return output.Status("ready")
	case "warn":
		return output.Status("degraded")
	case "fail":
		return output.Status("failed")
	}
	return s
}

func doctorRows(checks []doctorCheck) [][]string {
	rows := make([][]string, 0, len(checks))
	for _, c := range checks {
		rows = append(rows, []string{
			doctorStatus(c.Status),
			output.SanitizeLine(c.ID),
			output.SanitizeLine(c.Evidence),
		})
	}
	return rows
}

func doctorTally(checks []doctorCheck) string {
	counts := map[string]int{}
	for _, c := range checks {
		counts[c.Status]++
	}
	return fmt.Sprintf("%d pass, %d warn, %d fail, %d unknown", counts["pass"], counts["warn"], counts["fail"], counts["unknown"])
}

func renderDoctor(r doctorReport) {
	output.Table([]string{"status", "check", "evidence"}, doctorRows(r.Checks))
	output.Println()
	output.Println(doctorTally(r.Checks))
	if r.Selftest != nil {
		output.Println()
		output.Println("Isolation self-test " + output.SanitizeLine(r.Selftest.ID))
		if r.Selftest.Error != nil {
			output.Errorf("self-test error: %s", *r.Selftest.Error)
		}
		output.Table([]string{"status", "check", "evidence"}, doctorRows(r.Selftest.Checks))
		output.Println()
		output.Println(doctorTally(r.Selftest.Checks))
		for _, n := range r.Selftest.Notes {
			output.Println(output.Dim("note: " + n))
		}
		if len(r.Selftest.Leftovers) > 0 {
			output.Warnf("cleanup incomplete, namespaces left for the reaper: %s", output.SanitizeLine(strings.Join(r.Selftest.Leftovers, ", ")))
		}
	}
	all := append([]doctorCheck{}, r.Checks...)
	if r.Selftest != nil {
		all = append(all, r.Selftest.Checks...)
	}
	var fixes []doctorCheck
	for _, c := range all {
		if c.Status != "pass" && c.Fix != "" {
			fixes = append(fixes, c)
		}
	}
	if len(fixes) == 0 {
		return
	}
	output.Println()
	output.Println("Fixes")
	for _, c := range fixes {
		output.Printf("  %s: %s\n", output.SanitizeLine(c.ID), output.SanitizeLine(c.Fix))
		if c.Docs != "" {
			output.Printf("    %s\n", output.SanitizeLine(c.Docs))
		}
	}
}
