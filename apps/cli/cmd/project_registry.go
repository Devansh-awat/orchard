package cmd

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func projectRegistryCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "registry",
		Aliases: []string{"registries", "pull-secret"},
		Short:   "Manage credentials for pulling private images into the scoped project",
		Long: "A credential is attached to every app and job in the project whose image is hosted " +
			"on that registry, so ghcr.io/org/app pulls with the ghcr.io credential and a bare " +
			"user/app pulls with the docker.io one. One credential per registry; setting it again " +
			"replaces it.",
	}
	c.AddCommand(
		projectRegistryListCmd(),
		projectRegistrySetCmd(),
		projectRegistryRemoveCmd(),
	)
	return c
}

func projectRegistryPath(projectID string, rest ...string) string {
	p := "/projects/" + url.PathEscape(projectID) + "/registry-credentials"
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

func projectRegistryListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the registries this project can pull private images from",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), projectRegistryPath(projectID), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, c := range asList(raw) {
				rows = append(rows, []string{pick(c, "id"), pick(c, "registry"), pick(c, "username"), pick(c, "updatedAt")})
			}
			output.Table([]string{"id", "registry", "username", "updated"}, rows)
			return nil
		},
	}
}

func projectRegistrySetCmd() *cobra.Command {
	var username, password string
	var passwordStdin bool
	c := &cobra.Command{
		Use:   "set <registry>",
		Short: "Add or replace the credential for a registry (ghcr.io, docker.io, registry.gitlab.com, ...)",
		Long: "The credential is verified against the registry before it is stored. For ghcr.io use " +
			"your GitHub username and a classic personal access token with read:packages; for " +
			"docker.io use a Docker Hub access token.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if username == "" {
				return fmt.Errorf("--username is required")
			}
			if passwordStdin {
				b, err := io.ReadAll(os.Stdin)
				if err != nil {
					return err
				}
				password = strings.TrimRight(string(b), "\r\n")
			}
			if password == "" {
				return fmt.Errorf("pass --password or --password-stdin")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"registry": args[0], "username": username, "password": password}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPut, projectRegistryPath(projectID), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("%s will pull from %s as %s", projectID, pick(raw, "registry"), pick(raw, "username"))
			return nil
		},
	}
	c.Flags().StringVarP(&username, "username", "u", "", "registry username")
	c.Flags().StringVarP(&password, "password", "p", "", "password or access token")
	c.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read the password or token from stdin")
	return c
}

func projectRegistryRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <id>",
		Aliases: []string{"rm", "delete"},
		Short:   "Remove a registry credential",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, projectRegistryPath(projectID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("removed registry credential %s", args[0])
			return nil
		},
	}
}
