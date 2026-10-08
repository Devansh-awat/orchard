package cmd

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func projectCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "project",
		GroupID: groupResources,
		Aliases: []string{"projects", "proj"},
		Short:   "Manage projects",
	}
	c.AddCommand(
		projectListCmd(),
		projectGetCmd(),
		projectCreateCmd(),
		projectUpdateCmd(),
		projectDeleteCmd(),
		projectSyncCmd(),
		projectIconCmd(),
		projectBackgroundCmd(),
		projectMemberCmd(),
		projectInvitationCmd(),
		projectTransferCmd(),
		projectRegistryCmd(),
	)
	return c
}

func projectTransferCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "transfer",
		Short: "Transfer ownership of a project to another member",
		Long: "Ownership decides whose resource allowance a project's apps and databases are " +
			"billed against, so it moves in two steps: the current owner (or an org admin) " +
			"opens a request, and the recipient accepts it. The new owner must already be a " +
			"member of the project and becomes a project admin on accept.",
	}
	c.AddCommand(
		projectTransferRequestCmd(),
		projectTransferCancelCmd(),
		projectTransferListCmd(),
		projectTransferAcceptCmd(),
		projectTransferDeclineCmd(),
	)
	return c
}

func transferTarget(arg string) map[string]any {
	if strings.Contains(arg, "@") {
		return map[string]any{"email": arg}
	}
	return map[string]any{"userId": arg}
}

func projectTransferRequestCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "request <email|userId>",
		Short: "Ask another project member to take ownership of the scoped project",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw map[string]any
			path := "/projects/" + url.PathEscape(projectID) + "/transfer-request"
			if err := cl.Send(cmd.Context(), http.MethodPost, path, transferTarget(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("transfer requested — waiting for %s to accept", args[0])
			return nil
		},
	}
}

func projectTransferCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel",
		Short: "Withdraw the scoped project's pending ownership transfer",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			path := "/projects/" + url.PathEscape(projectID) + "/transfer-request"
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			output.Successf("ownership transfer canceled")
			return nil
		},
	}
}

func projectTransferListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List ownership transfers waiting on you",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw []map[string]any
			if err := cl.GetJSON(cmd.Context(), "/project-transfers", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, r := range raw {
				project, _ := r["project"].(map[string]any)
				from, _ := r["from"].(map[string]any)
				rows = append(rows, []string{
					str(r["id"]),
					str(project["name"]),
					str(from["email"]),
					str(r["expiresAt"]),
				})
			}
			output.Table([]string{"request id", "project", "from", "expires"}, rows)
			return nil
		},
	}
}

func projectTransferAcceptCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "accept <requestId>",
		Short: "Accept ownership of a project offered to you",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := output.Confirm("everything in this project will be billed against your resource allowance. accept?", yesFlag); err != nil {
				return err
			}
			var raw map[string]any
			path := "/project-transfers/" + url.PathEscape(args[0]) + "/accept"
			if err := cl.Send(cmd.Context(), http.MethodPost, path, nil, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			output.Successf("you now own this project")
			if promoted, _ := raw["promotedToAdmin"].(bool); promoted {
				output.Successf("your project role was raised to admin")
			}
			return nil
		},
	}
}

func projectTransferDeclineCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "decline <requestId>",
		Short: "Decline ownership of a project offered to you",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := "/project-transfers/" + url.PathEscape(args[0]) + "/decline"
			if err := cl.Send(cmd.Context(), http.MethodPost, path, nil, nil); err != nil {
				return err
			}
			output.Successf("transfer declined")
			return nil
		},
	}
}

func projectListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List projects (all orgs, or the scoped one)",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			path := "/projects"
			if v := scopedOrg(cfg); v != "" {
				org, oerr := resolveOrg(cmd.Context(), cl, v)
				if oerr != nil {
					return oerr
				}
				path += "?orgId=" + url.QueryEscape(str(org["id"]))
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, p := range asList(raw) {
				rows = append(rows, []string{
					pick(p, "id"),
					pick(p, "slug", "name"),
					pick(p, "name"),
					pick(p, "organizationId", "orgId"),
				})
			}
			output.Table([]string{"id", "slug", "name", "org"}, rows)
			return nil
		},
	}
}

func projectGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <project>",
		Short: "Show a project",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			p, err := resolveProject(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(str(p["id"])), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"slug", pick(raw, "slug")},
				{"org", pick(raw, "organizationId")},
				{"namespace", pick(raw, "namespace")},
			}
			for _, k := range []string{"description", "repositoryUrl", "icon"} {
				if v := pick(raw, k); v != "" {
					pairs = append(pairs, [2]string{k, v})
				}
			}
			pairs = append(pairs,
				[2]string{"deployments", strconv.Itoa(len(asList(raw["deployments"])))},
				[2]string{"databases", strconv.Itoa(len(asList(raw["databases"])))},
				[2]string{"members", strconv.Itoa(len(asList(raw["members"])))},
				[2]string{"created", pick(raw, "createdAt")},
			)
			output.KV(pairs)
			return nil
		},
	}
}

func projectCreateCmd() *cobra.Command {
	var name, slug, description string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a project in the scoped organization",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"organizationId": orgID, "name": name}
			if slug != "" {
				body["slug"] = slug
			}
			if description != "" {
				body["description"] = description
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects", body, &raw); err != nil {
				return err
			}
			output.Successf("created project %s (%s)", pick(raw, "slug", "name"), pick(raw, "id"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "project name (required)")
	c.Flags().StringVar(&slug, "slug", "", "url slug (default: derived from the name)")
	c.Flags().StringVar(&description, "description", "", "project description")
	_ = c.MarkFlagRequired("name")
	return c
}

func projectUpdateCmd() *cobra.Command {
	var name, description, repo, icon, background string
	c := &cobra.Command{
		Use:   "update <project>",
		Short: "Update project fields",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			p, err := resolveProject(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			// PATCH /projects/:id accepts name, description, repositoryUrl,
			// icon, backgroundImage; the nullable ones clear on empty string.
			body := map[string]any{}
			set := func(flag, key, v string, nullable bool) {
				if !cmd.Flags().Changed(flag) {
					return
				}
				if v == "" && nullable {
					body[key] = nil
					return
				}
				body[key] = v
			}
			set("name", "name", name, false)
			set("description", "description", description, true)
			set("repository-url", "repositoryUrl", repo, true)
			set("icon", "icon", icon, true)
			set("background-image", "backgroundImage", background, true)
			if len(body) == 0 {
				return errors.New("nothing to update: pass at least one of --name/--description/--repository-url/--icon/--background-image")
			}
			var raw any
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/projects/"+url.PathEscape(str(p["id"])), body, &raw); err != nil {
				return err
			}
			output.Successf("updated project %s", pick(p, "slug", "name", "id"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "new project name")
	c.Flags().StringVar(&description, "description", "", "new description (empty string clears)")
	c.Flags().StringVar(&repo, "repository-url", "", "linked repository URL (empty string clears)")
	c.Flags().StringVar(&icon, "icon", "", "icon emoji or image URL (empty string clears)")
	c.Flags().StringVar(&background, "background-image", "", "background image URL (empty string clears)")
	return c
}

func projectDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <project>",
		Aliases: []string{"rm"},
		Short:   "Delete a project and everything in it",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			p, err := resolveProject(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			label := pick(p, "slug", "name", "id")
			name := str(p["name"])
			if err := output.ConfirmTyped(fmt.Sprintf("delete project %s and all of its deployments, databases (with their data and backups), domains, jobs and environments", label), name, yesFlag); err != nil {
				return err
			}
			body := map[string]string{"confirmName": name}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/projects/"+url.PathEscape(str(p["id"])), body, nil); err != nil {
				return err
			}
			output.Successf("deleted project %s", label)
			return nil
		},
	}
}

func projectSyncCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "sync <project>",
		Short: "Pull live cluster state for the project's namespace into Orchard",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			p, err := resolveProject(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			ns := str(p["namespace"])
			if ns == "" {
				return fmt.Errorf("project %q has no namespace", args[0])
			}
			// the server exposes sync as GET /sync/:namespace
			// (kubernetes.controller.ts); a POST 404s.
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/sync/"+url.PathEscape(ns), &raw); err != nil {
				return err
			}
			output.Successf("synced namespace %s", ns)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
}

func projectIconCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "icon",
		Short: "Manage the project icon",
	}
	c.AddCommand(projectIconSetCmd())
	return c
}

func projectIconSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <project> <file>",
		Short: "Upload a project icon (jpeg/png/gif/webp, max 2MB)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			p, err := resolveProject(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			f, err := os.Open(args[1])
			if err != nil {
				return err
			}
			defer f.Close()
			path := "/projects/" + url.PathEscape(str(p["id"])) + "/icon"
			if _, err := cl.Upload(cmd.Context(), path, "file", filepath.Base(args[1]), f); err != nil {
				return err
			}
			output.Successf("icon updated for %s", pick(p, "slug", "name", "id"))
			return nil
		},
	}
}

func projectBackgroundCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "background",
		Short: "Manage the project background image",
	}
	c.AddCommand(projectBackgroundSetCmd())
	return c
}

func projectBackgroundSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <file>",
		Short: "Upload a background image for the scoped project (jpeg/png/webp, max 8MB)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			f, err := os.Open(args[0])
			if err != nil {
				return err
			}
			defer f.Close()
			path := "/projects/" + url.PathEscape(projectID) + "/background-image"
			if _, err := cl.Upload(cmd.Context(), path, "file", filepath.Base(args[0]), f); err != nil {
				return err
			}
			output.Successf("background image updated")
			return nil
		},
	}
}

func projectMemberCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "member",
		Aliases: []string{"members"},
		Short:   "Manage members of the scoped project",
	}
	c.AddCommand(
		projectMemberListCmd(),
		projectMemberAddCmd(),
		projectMemberRemoveCmd(),
		projectMemberSetRoleCmd(),
	)
	return c
}

func projectMemberListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List project members",
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw["members"])
			}
			rows := [][]string{}
			for _, m := range asList(raw["members"]) {
				user, _ := m["user"].(map[string]any)
				role, _ := m["role"].(map[string]any)
				name := strings.TrimSpace(str(user["firstName"]) + " " + str(user["lastName"]))
				rows = append(rows, []string{
					pick(m, "id"),
					str(user["email"]),
					name,
					str(role["name"]),
				})
			}
			output.Table([]string{"member id", "email", "name", "role"}, rows)
			return nil
		},
	}
}

func projectMemberAddCmd() *cobra.Command {
	var role string
	c := &cobra.Command{
		Use:   "add <email>",
		Short: "Add an org member to the project (emails without an account get an invitation)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validProjectRole(role); err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			body := map[string]any{"email": args[0], "role": role}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(projectID)+"/members", body, &raw); err != nil {
				return err
			}
			if invited, _ := raw["invited"].(bool); invited {
				output.Successf("invitation sent to %s (no account yet)", args[0])
			} else {
				output.Successf("added %s as %s", args[0], role)
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&role, "role", "member", "project role: admin|member|viewer")
	return c
}

func projectMemberRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <memberId>",
		Aliases: []string{"rm"},
		Short:   "Remove a member from the project",
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
			if err := output.Confirm(fmt.Sprintf("remove member %s from the project?", args[0]), yesFlag); err != nil {
				return err
			}
			path := "/projects/" + url.PathEscape(projectID) + "/members/" + url.PathEscape(args[0])
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			output.Successf("removed member %s", args[0])
			return nil
		},
	}
}

func projectMemberSetRoleCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-role <memberId> <role>",
		Short: "Change a member's project role (admin|member|viewer)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validProjectRole(args[1]); err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			path := "/projects/" + url.PathEscape(projectID) + "/members/" + url.PathEscape(args[0])
			if err := cl.Send(cmd.Context(), http.MethodPatch, path, map[string]any{"role": args[1]}, nil); err != nil {
				return err
			}
			output.Successf("member %s is now %s", args[0], args[1])
			return nil
		},
	}
}

func validProjectRole(r string) error {
	switch r {
	case "admin", "member", "viewer":
		return nil
	}
	return fmt.Errorf("invalid role %q (want admin|member|viewer)", r)
}

func projectInvitationCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "invitation",
		Aliases: []string{"invitations", "invite"},
		Short:   "Manage pending invitations for the scoped project",
	}
	c.AddCommand(projectInvitationRevokeCmd())
	return c
}

func projectInvitationRevokeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "revoke <invitationId>",
		Short: "Revoke a pending project invitation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := output.Confirm(fmt.Sprintf("revoke invitation %s?", args[0]), yesFlag); err != nil {
				return err
			}
			path := "/projects/" + url.PathEscape(projectID) + "/invitations/" + url.PathEscape(args[0])
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			output.Successf("revoked invitation %s", args[0])
			return nil
		},
	}
}
