package cmd

import (
	"net/http"
	"net/url"
	"strconv"

	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "deploy",
		Aliases: []string{"deployment", "deployments"},
		Short:   "Manage deployments",
	}
	c.AddCommand(
		deployListCmd(),
		deployGetCmd(),
		deployScaleCmd(),
		deployRestartCmd(),
		deployRebuildCmd(),
		deployLogsCmd(),
	)
	return c
}

func deployListCmd() *cobra.Command {
	var project string
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List deployments",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/deployments"
			if project != "" {
				path = "/projects/" + url.PathEscape(project) + "/deployments"
			}
			var raw any
			if err := cl.GetJSON(path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range asList(raw) {
				rows = append(rows, []string{
					pick(d, "id"),
					pick(d, "name", "slug"),
					output.Status(pick(d, "status", "state", "phase")),
					pick(d, "image"),
					pick(d, "replicas"),
				})
			}
			output.Table([]string{"id", "name", "status", "image", "replicas"}, rows)
			return nil
		},
	}
	c.Flags().StringVarP(&project, "project", "p", "", "filter by project id")
	return c
}

func deployGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON("/deployments/"+url.PathEscape(args[0]), &raw); err != nil {
				return err
			}
			return output.JSON(raw)
		},
	}
}

func deployScaleCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "scale <id> <replicas>",
		Short: "Scale a deployment to N replicas",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			replicas, perr := strconv.Atoi(args[1])
			if perr != nil {
				return perr
			}
			body := map[string]any{"replicas": replicas}
			if err := cl.Send(http.MethodPost, "/deployments/"+url.PathEscape(args[0])+"/scale", body, nil); err != nil {
				return err
			}
			output.Successf("scaled %s to %d replicas", args[0], replicas)
			return nil
		},
	}
}

func deployRestartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "restart <id>",
		Short: "Restart a deployment's pods",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(http.MethodPost, "/deployments/"+url.PathEscape(args[0])+"/restart", nil, nil); err != nil {
				return err
			}
			output.Successf("restarted %s", args[0])
			return nil
		},
	}
}

func deployRebuildCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rebuild <id>",
		Short: "Rebuild a deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(http.MethodPost, "/deployments/"+url.PathEscape(args[0])+"/rebuild", nil, nil); err != nil {
				return err
			}
			output.Successf("triggered rebuild of %s", args[0])
			return nil
		},
	}
}

func deployLogsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logs <id>",
		Short: "Fetch deployment logs",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			res, err := cl.Do(http.MethodGet, "/deployments/"+url.PathEscape(args[0])+"/logs", nil)
			if err != nil {
				return err
			}
			output.Raw(res)
			return nil
		},
	}
}
