package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func sshIdentityCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "ssh-identity",
		GroupID: groupResources,
		Aliases: []string{"ssh-key", "identity"},
		Short:   "Manage the ssh identities your sandboxes accept",
	}
	c.AddCommand(
		sshIdentityListCmd(),
		sshIdentityAddCmd(),
		sshIdentityRemoveCmd(),
		sshIdentityImportGithubCmd(),
	)
	return c
}

// sshIdentityKeyValue resolves one --key value: @file reads the file, a bare
// value that is not a public key but exists on disk is read as a file, and
// anything else is taken literally.
func sshIdentityKeyValue(v string) (string, error) {
	if path, ok := strings.CutPrefix(v, "@"); ok {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(data)), nil
	}
	if !strings.HasPrefix(v, "ssh-") && !strings.HasPrefix(v, "ecdsa-") {
		if data, err := os.ReadFile(v); err == nil {
			return strings.TrimSpace(string(data)), nil
		}
	}
	return strings.TrimSpace(v), nil
}

func fetchSSHIdentities(ctx context.Context, cl *api.Client) (map[string]any, error) {
	var raw map[string]any
	if err := cl.GetJSON(ctx, "/ssh-identities", &raw); err != nil {
		return nil, sandboxFeatureError(err)
	}
	return raw, nil
}

// resolveSSHIdentity matches exact id, then exact name, then a unique id prefix.
func resolveSSHIdentity(ctx context.Context, cl *api.Client, v string) (map[string]any, error) {
	raw, err := fetchSSHIdentities(ctx, cl)
	if err != nil {
		return nil, err
	}
	items := asList(raw["identities"])
	for _, s := range items {
		if str(s["id"]) == v {
			return s, nil
		}
	}
	for _, s := range items {
		if str(s["name"]) == v {
			return s, nil
		}
	}
	matches := []map[string]any{}
	for _, s := range items {
		if strings.HasPrefix(str(s["id"]), v) {
			matches = append(matches, s)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		labels := make([]string, 0, len(matches))
		for _, m := range matches {
			labels = append(labels, str(m["name"])+" ("+str(m["id"])+")")
		}
		return nil, fmt.Errorf("ssh identity %q is ambiguous between: %s", v, strings.Join(labels, ", "))
	}
	return nil, fmt.Errorf("ssh identity %q not found", v)
}

// truncateSSHKey keeps the key type and the comment tail readable while
// eliding the bulk of the base64 material.
func truncateSSHKey(k string) string {
	if len(k) <= 35 {
		return k
	}
	return k[:20] + "..." + k[len(k)-12:]
}

func sshIdentityListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List your ssh identities",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			raw, err := fetchSSHIdentities(cmd.Context(), cl)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, s := range asList(raw["identities"]) {
				rows = append(rows, []string{
					pick(s, "name"),
					truncateSSHKey(pick(s, "publicKey")),
					pick(s, "createdAt"),
				})
			}
			output.Table([]string{"name", "key", "created"}, rows)
			return nil
		},
	}
}

func sshIdentityAddCmd() *cobra.Command {
	var keyValue string
	c := &cobra.Command{
		Use:   "add <name>",
		Short: "Register an ssh public key as a named identity",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if keyValue == "" {
				return errors.New("--key is required: a literal key, @file, or a file path")
			}
			key, err := sshIdentityKeyValue(keyValue)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "publicKey": key}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/ssh-identities", body, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			output.Successf("added ssh identity %s", pick(raw, "name"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&keyValue, "key", "", "ssh public key: literal, @file, or a file path")
	return c
}

func sshIdentityRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <name>",
		Aliases: []string{"rm"},
		Short:   "Delete an ssh identity",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			ident, err := resolveSSHIdentity(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if err := output.Confirm(fmt.Sprintf("delete ssh identity %s", pick(ident, "name")), yesFlag); err != nil {
				return err
			}
			path := "/ssh-identities/" + url.PathEscape(str(ident["id"]))
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				var apiErr *api.APIError
				if errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict {
					return errors.New(apiErr.Message)
				}
				return err
			}
			output.Successf("deleted ssh identity %s", pick(ident, "name"))
			return nil
		},
	}
}

func sshIdentityImportGithubCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "import-github",
		Short: "Import your public ssh keys from GitHub as identities",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/ssh-identities/import-github", nil, &raw); err != nil {
				return sandboxFeatureError(err)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			created := asList(raw["identities"])
			if len(created) == 0 {
				output.Successf("no new keys")
				return nil
			}
			names := make([]string, 0, len(created))
			for _, s := range created {
				names = append(names, pick(s, "name"))
			}
			output.Successf("imported %s", strings.Join(names, ", "))
			return nil
		},
	}
}
