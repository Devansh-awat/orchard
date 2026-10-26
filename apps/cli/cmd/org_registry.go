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

func orgRegistryCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "registry",
		Aliases: []string{"registries", "pull-secret"},
		Short:   "Manage default registry credentials for the scoped organization",
		Long: "Default Docker logins inherited by every project for builds, apps and jobs. " +
			"Project credentials override these defaults; build environment credentials override both. " +
			"Requires organization owner or admin access. Tokens are never returned.",
	}
	c.AddCommand(
		orgRegistryListCmd(),
		orgRegistrySetCmd(),
		orgRegistryRemoveCmd(),
	)
	return c
}

func orgRegistryPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/registry-credentials"
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

func orgRegistryListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List organization registry defaults",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), orgRegistryPath(orgID), &raw); err != nil {
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

func orgRegistrySetCmd() *cobra.Command {
	var username, password string
	var passwordStdin bool
	c := &cobra.Command{
		Use:   "set <registry>",
		Short: "Add or replace the credential for a registry (ghcr.io, docker.io, registry.gitlab.com, ...)",
		Long: "The credential is verified against the registry before it is stored. For ghcr.io use " +
			"your GitHub username and a classic personal access token with read:packages; for " +
			"docker.io or dhi.io use your Docker username and access token.",
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
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"registry": args[0], "username": username, "password": password}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPut, orgRegistryPath(orgID), body, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("%s will pull from %s as %s", orgID, pick(raw, "registry"), pick(raw, "username"))
			return nil
		},
	}
	c.Flags().StringVarP(&username, "username", "u", "", "registry username")
	c.Flags().StringVarP(&password, "password", "p", "", "password or access token")
	c.Flags().BoolVar(&passwordStdin, "password-stdin", false, "read the password or token from stdin")
	return c
}

func orgRegistryRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <id>",
		Aliases: []string{"rm", "delete"},
		Short:   "Remove a registry credential",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm("remove organization registry credential "+args[0], yesFlag); err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, orgRegistryPath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("removed registry credential %s", args[0])
			return nil
		},
	}
}
