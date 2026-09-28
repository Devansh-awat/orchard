package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var (
	outputFlag  string
	yesFlag     bool
	orgFlag     string
	projectFlag string
	envFlag     string
)

// Version is set via -ldflags at build time.
var Version = "dev"

const (
	groupCore      = "core"
	groupResources = "resources"
	groupUtility   = "utility"
)

// Execute runs the CLI and returns the process exit code, rendering the error
// in whichever format the invocation asked for.
func Execute(ctx context.Context) int {
	root := rootCmd()
	err := root.ExecuteContext(ctx)
	if err == nil {
		return exitcode.OK
	}

	code := exitcode.FromError(err)
	if output.Resolve(outputFlag) == output.FormatJSON {
		status := 0
		var apiErr *api.APIError
		if errors.As(err, &apiErr) {
			status = apiErr.Status
		}
		line, _ := json.Marshal(map[string]any{"error": map[string]any{
			"status":  status,
			"code":    code,
			"message": err.Error(),
		}})
		fmt.Fprintln(os.Stderr, string(line))
	} else {
		output.Errorf("%s", err.Error())
	}
	return code
}

func rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "orchard",
		Short: "Orchard — deploy and manage apps on HackClub's platform",
		Long: "orchard is the command-line interface for the Orchard platform.\n\n" +
			"It speaks the same REST API as the web UI and the MCP server, so every\n" +
			"capability is available here. Output is pretty in a terminal and JSON when\n" +
			"piped (or with --output json), which makes it equally useful for humans\n" +
			"and for AI agents.",
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.PersistentFlags().StringVarP(&outputFlag, "output", "o", "", "output format: table|json (default: auto by TTY)")
	root.PersistentFlags().BoolVarP(&yesFlag, "yes", "y", false, "skip confirmation prompts (required for mutations when not a TTY)")
	root.PersistentFlags().StringVar(&orgFlag, "org", "", "organization id or slug (overrides the saved context)")
	root.PersistentFlags().StringVar(&projectFlag, "project", "", "project id or slug (overrides the saved context)")
	root.PersistentFlags().StringVar(&envFlag, "env", "", "environment id or name (overrides the saved context)")
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		return &exitcode.UsageError{Err: err}
	})

	root.AddGroup(
		&cobra.Group{ID: groupCore, Title: "Core Commands:"},
		&cobra.Group{ID: groupResources, Title: "Resource Commands:"},
		&cobra.Group{ID: groupUtility, Title: "Utility Commands:"},
	)
	root.SetHelpCommandGroupID(groupUtility)
	root.SetCompletionCommandGroupID(groupUtility)

	root.AddCommand(
		authCmd(),
		useCmd(),
		upCmd(),
		importCmd(),
		linkCmd(),
		unlinkCmd(),
		contextCmd(),
		apiCmd(),
		orgCmd(),
		projectCmd(),
		envCmd(),
		deployCmd(),
		dbCmd(),
		podCmd(),
		sandboxCmd(),
		sshIdentityCmd(),
		serviceCmd(),
		domainCmd(),
		jobCmd(),
		jobRunCmd(),
		templateCmd(),
		composeCmd(),
		githubCmd(),
		tailscaleCmd(),
		webhookCmd(),
		eventsCmd(),
		observeCmd(),
		memberCmd(),
		invitationCmd(),
		notifyCmd(),
		alertCmd(),
		statusPageCmd(),
		gitCmd(),
		auditCmd(),
		quotaCmd(),
		overviewCmd(),
		openCmd(),
		userCmd(),
		uiCmd(),
		topCmd(),
		consoleCmd(),
		commandsCmd(),
		licensesCmd(),
		exitCodesCmd(),
	)
	return root
}

// fmtFlag resolves the effective output format for the current invocation.
func fmtFlag() output.Format { return output.Resolve(outputFlag) }

// client loads config and returns an authenticated API client.
func client() (*api.Client, *config.Config, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	if err := cfg.RequireToken(); err != nil {
		return nil, cfg, err
	}
	return api.New(cfg.APIURL, cfg.Token), cfg, nil
}
