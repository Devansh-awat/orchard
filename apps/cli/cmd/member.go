package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func memberCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "member",
		GroupID: groupResources,
		Aliases: []string{"members"},
		Short:   "Manage members of the scoped organization",
	}
	c.AddCommand(
		memberListCmd(),
		memberInviteCmd(),
		memberRemoveCmd(),
		memberSetRoleCmd(),
		memberInvitesCmd(),
	)
	return c
}

func memberPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/members"
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

func memberInvitationPath(orgID string, rest ...string) string {
	p := "/organizations/" + url.PathEscape(orgID) + "/invitations"
	for _, r := range rest {
		p += "/" + url.PathEscape(r)
	}
	return p
}

// validOrgRole mirrors the server rules: guests exist as an org role but can
// only be granted via set-role (invites at the org level reject guests).
func validOrgRole(r string, allowGuest bool) error {
	switch r {
	case "owner", "admin", "member":
		return nil
	case "guest":
		if allowGuest {
			return nil
		}
		return fmt.Errorf("guests can't be invited at the organization level: invite them to a project with `orchard project member add`")
	}
	want := "owner|admin|member"
	if allowGuest {
		want += "|guest"
	}
	return fmt.Errorf("invalid role %q (want %s)", r, want)
}

func memberUserName(u map[string]any) string {
	if name := strings.TrimSpace(str(u["firstName"]) + " " + str(u["lastName"])); name != "" {
		return name
	}
	return pick(u, "username")
}

func memberInviterName(m map[string]any) string {
	inv, _ := m["inviter"].(map[string]any)
	if inv == nil {
		return ""
	}
	if name := strings.TrimSpace(str(inv["firstName"]) + " " + str(inv["lastName"])); name != "" {
		return name
	}
	return pick(inv, "username", "email")
}

func memberListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List members of the organization",
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
			if err := cl.GetJSON(cmd.Context(), memberPath(orgID), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, m := range asList(raw) {
				user, _ := m["user"].(map[string]any)
				rows = append(rows, []string{
					pick(m, "id"),
					memberUserName(user),
					str(user["email"]),
					pick(m, "role"),
					pick(m, "addedAt", "createdAt"),
				})
			}
			output.Table([]string{"member id", "user", "email", "role", "joined"}, rows)
			return nil
		},
	}
}

func memberInviteCmd() *cobra.Command {
	var role string
	c := &cobra.Command{
		Use:   "invite <email>",
		Short: "Invite someone to the organization by email",
		Long: "Send an email invitation to join the scoped organization. The server never\n" +
			"direct-adds: even people who already have an account receive an invitation\n" +
			"they must accept themselves (it expires after 7 days).\n\n" +
			"Only owners can invite new owners. Guests can't be invited at the organization\n" +
			"level; use `orchard project member add` to invite a guest to a project.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validOrgRole(role, false); err != nil {
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
			body := map[string]any{"email": args[0], "role": role}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, memberPath(orgID), body, &raw); err != nil {
				return err
			}
			output.Successf("sent invitation to %s as %s (%s)", args[0], role, pick(raw, "id"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "member", "organization role: owner|admin|member")
	return c
}

func memberRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <memberId>",
		Aliases: []string{"rm"},
		Short:   "Remove a member from the organization",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			prompt := fmt.Sprintf("remove member %s from the organization and all of its projects", args[0])
			if err := output.Confirm(prompt, yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, memberPath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("removed member %s", args[0])
			return nil
		},
	}
}

func memberSetRoleCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-role <memberId> <role>",
		Short: "Change a member's organization role (owner|admin|member|guest)",
		Long: "Change a member's organization role. Owner-only on the server; owners\n" +
			"can't be demoted (transfer ownership instead) and setting guest requires\n" +
			"the member to already belong to at least one project.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validOrgRole(args[1], true); err != nil {
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
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, memberPath(orgID, args[0]), map[string]any{"role": args[1]}, &raw); err != nil {
				return err
			}
			output.Successf("member %s is now %s", args[0], args[1])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func memberInvitesCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "invites",
		Aliases: []string{"invitations"},
		Short:   "Manage the organization's pending invitations",
	}
	c.AddCommand(
		memberInvitesListCmd(),
		memberInvitesCancelCmd(),
		memberInvitesResendCmd(),
	)
	return c
}

func memberInvitesListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List pending invitations for the organization",
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
			if err := cl.GetJSON(cmd.Context(), memberInvitationPath(orgID), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, inv := range asList(raw) {
				rows = append(rows, []string{
					pick(inv, "id"),
					pick(inv, "email"),
					pick(inv, "role"),
					memberInviterName(inv),
					pick(inv, "createdAt"),
					pick(inv, "expiresAt"),
				})
			}
			output.Table([]string{"id", "email", "role", "invited by", "created", "expires"}, rows)
			return nil
		},
	}
}

func memberInvitesCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "cancel <invitationId>",
		Aliases: []string{"revoke", "rm"},
		Short:   "Cancel a pending invitation",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := output.Confirm(fmt.Sprintf("cancel invitation %s", args[0]), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, memberInvitationPath(orgID, args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("canceled invitation %s", args[0])
			return nil
		},
	}
}

func memberInvitesResendCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "resend <invitationId>",
		Short: "Resend a pending invitation's email",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			path := memberInvitationPath(orgID, args[0]) + "/resend"
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, path, nil, &raw); err != nil {
				return err
			}
			output.Successf("resent invitation %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}
