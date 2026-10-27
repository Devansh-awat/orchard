package cmd

import "github.com/spf13/cobra"

func logsCmd() *cobra.Command {
	c := deployLogsCmd()
	c.Use = "logs <deploymentId>"
	c.GroupID = groupCore
	c.Short = "Fetch or follow a deployment's logs (shortcut for `deploy logs`)"
	c.Example = "  orchard logs <deploymentId> -f\n  orchard logs <deploymentId> --build -f"
	return c
}
