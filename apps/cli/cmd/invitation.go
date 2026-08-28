package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func invitationCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "invitation",
		GroupID: groupCore,
		Aliases: []string{"invitations"},
		Short:   "View and act on organization invitations sent to you",
	}
	c.AddCommand(
		invitationListCmd(),
		invitationAcceptCmd(),
		invitationDeclineCmd(),
		invitationAcceptAllCmd(),
	)
	return c
}

func invitationActPath(id, action string) string {
	return "/invitations/by-id/" + url.PathEscape(id) + "/" + action
}

func invitationListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List your pending invitations",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/invitations/pending", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, inv := range asList(raw) {
				org, _ := inv["organization"].(map[string]any)
				proj, _ := inv["project"].(map[string]any)
				rows = append(rows, []string{
					pick(inv, "id"),
					pick(org, "name", "slug"),
					pick(proj, "name", "slug"),
					pick(inv, "role"),
					memberInviterName(inv),
					pick(inv, "expiresAt"),
				})
			}
			output.Table([]string{"id", "organization", "project", "role", "invited by", "expires"}, rows)
			return nil
		},
	}
}

// invitationAccept posts the by-id accept and renders the resulting membership.
func invitationAccept(cmd *cobra.Command, cl *api.Client, id string) (map[string]any, error) {
	var raw map[string]any
	if err := cl.Send(cmd.Context(), http.MethodPost, invitationActPath(id, "accept"), nil, &raw); err != nil {
		return nil, err
	}
	if org, ok := raw["organization"].(map[string]any); ok {
		output.Successf("joined %s as %s", pick(org, "name", "slug", "id"), pick(raw, "role"))
	} else {
		output.Successf("accepted invitation %s", id)
	}
	return raw, nil
}

func invitationAcceptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "accept <id>",
		Short: "Accept a pending invitation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			raw, err := invitationAccept(cmd, cl, args[0])
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func invitationDeclineCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "decline <id>",
		Short: "Decline a pending invitation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, invitationActPath(args[0], "decline"), nil, &raw); err != nil {
				return err
			}
			output.Successf("declined invitation %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func invitationAcceptAllCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "accept-all",
		Short: "Accept every pending invitation",
		Long: "Accept all of your pending invitations. The API deliberately has no bulk\n" +
			"accept (POST /invitations/accept-pending only lists, so a single request\n" +
			"can never join you to arbitrary orgs), so this fetches the pending list\n" +
			"and accepts each invitation individually.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/invitations/pending", &raw); err != nil {
				return err
			}
			pending := asList(raw)
			if len(pending) == 0 {
				output.Warnf("no pending invitations")
				if fmtFlag() == output.FormatJSON {
					return output.JSON([]any{})
				}
				return nil
			}
			if err := output.Confirm(fmt.Sprintf("accept all %d pending invitation(s)", len(pending)), yesFlag); err != nil {
				return err
			}
			accepted := []map[string]any{}
			failed := []string{}
			for _, inv := range pending {
				id := pick(inv, "id")
				if id == "" {
					continue
				}
				m, aerr := invitationAccept(cmd, cl, id)
				if aerr != nil {
					failed = append(failed, id)
					output.Warnf("accept %s: %s", id, aerr)
					continue
				}
				accepted = append(accepted, m)
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(accepted); err != nil {
					return err
				}
			}
			if len(failed) > 0 {
				return fmt.Errorf("accepted %d of %d invitation(s); failed: %s", len(accepted), len(pending), strings.Join(failed, ", "))
			}
			output.Successf("accepted %d invitation(s)", len(accepted))
			return nil
		},
	}
}
