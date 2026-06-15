package cmd

import (
	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/config"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

var outputFlag string

// Version is set via -ldflags at build time.
var Version = "dev"

func Execute() error {
	return rootCmd().Execute()
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

	root.AddCommand(
		authCmd(),
		apiCmd(),
		projectCmd(),
		deployCmd(),
		dbCmd(),
		uiCmd(),
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
