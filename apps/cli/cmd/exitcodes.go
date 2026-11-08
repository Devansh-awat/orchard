package cmd

import (
	"strconv"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

// exitCodeDoc documents one stable exit code for scripts and agents.
type exitCodeDoc struct {
	Code        int    `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// exitCodeDocs mirrors internal/exitcode: every code the CLI can exit with,
// in ascending order. Keep in lockstep with exitcode.FromError.
var exitCodeDocs = []exitCodeDoc{
	{exitcode.OK, "ok", "success"},
	{exitcode.Generic, "generic", "unexpected failure without a more specific code"},
	{exitcode.Usage, "usage", "bad invocation: unknown flag or argument, or a confirmation prompt was refused (pass --yes)"},
	{exitcode.Auth, "auth", "authentication rejected (HTTP 401): run `orchard auth login`"},
	{exitcode.NotFound, "not-found", "resource not found (HTTP 404)"},
	{exitcode.Invalid, "invalid", "the API rejected the request (other HTTP 4xx)"},
	{exitcode.RateLimited, "rate-limited", "rate limited (HTTP 429): retry with backoff"},
	{exitcode.Server, "server", "server error (HTTP 5xx)"},
	{exitcode.Deadline, "deadline", "timed out: request deadline exceeded or --wait ran out of --timeout"},
	{exitcode.DeployFailed, "deploy-failed", "the build failed while waiting for a deploy (build error and log tail on stderr)"},
	{exitcode.DeployCrashing, "deploy-crashing", "the deploy built but its pods are crashing or unhealthy (pod reason and log tail on stderr), or `db diagnose` found the database down"},
	{exitcode.ChecksFailed, "checks-failed", "`orchard doctor` found at least one failing check"},
	{exitcode.Interrupted, "interrupted", "interrupted by Ctrl-C (SIGINT)"},
}

// exitCodesCmd is a hidden reference command: `orchard exit-codes` prints the
// table, and `orchard help exit-codes` renders this help text, so both
// spellings work. Hidden keeps the top-level help focused.
func exitCodesCmd() *cobra.Command {
	long := "orchard exits with a stable, script-friendly code so CI jobs and agents\n" +
		"can branch on failure class instead of parsing error text:\n\n"
	for _, ec := range exitCodeDocs {
		long += "  " + pad3(ec.Code) + "  " + ec.Name + ": " + ec.Description + "\n"
	}
	return &cobra.Command{
		Use:    "exit-codes",
		Hidden: true,
		Short:  "Explain the CLI's stable exit codes",
		Long:   long,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if fmtFlag() == output.FormatJSON {
				return output.JSON(exitCodeDocs)
			}
			pairs := make([][2]string, 0, len(exitCodeDocs))
			for _, ec := range exitCodeDocs {
				pairs = append(pairs, [2]string{strconv.Itoa(ec.Code), ec.Name + ": " + ec.Description})
			}
			output.KV(pairs)
			return nil
		},
	}
}

// pad3 right-aligns a code to three columns so the help table lines up.
func pad3(n int) string {
	s := strconv.Itoa(n)
	for len(s) < 3 {
		s = " " + s
	}
	return s
}
