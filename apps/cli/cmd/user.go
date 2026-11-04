package cmd

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func userCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "user",
		GroupID: groupCore,
		Short:   "Manage your user profile",
	}
	c.AddCommand(userProfileCmd(), userAvatarCmd())
	return c
}

func userProfileCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "profile",
		Short: "Show your profile",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var me map[string]any
			if err := cl.GetJSON(cmd.Context(), "/auth/me", &me); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(me)
			}
			output.KV([][2]string{
				{"id", pick(me, "id")},
				{"email", pick(me, "email")},
				{"username", pick(me, "username")},
				{"first name", pick(me, "firstName")},
				{"last name", pick(me, "lastName")},
				{"avatar", pick(me, "imageUrl")},
				{"hack club id", pick(me, "hackClubId")},
			})
			return nil
		},
	}
	c.AddCommand(userProfileUpdateCmd())
	return c
}

func userProfileUpdateCmd() *cobra.Command {
	var username, firstName, lastName string
	c := &cobra.Command{
		Use:   "update",
		Short: "Update your profile (only flagged fields change)",
		Long: "Update your profile. Only the flags you pass change; pass --first-name\n" +
			"\"\" or --last-name \"\" to clear a field. Usernames must be unique.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			if cmd.Flags().Changed("username") {
				if username == "" {
					return errors.New("--username can't be empty")
				}
				body["username"] = username
			}
			if cmd.Flags().Changed("first-name") {
				if firstName == "" {
					body["firstName"] = nil
				} else {
					body["firstName"] = firstName
				}
			}
			if cmd.Flags().Changed("last-name") {
				if lastName == "" {
					body["lastName"] = nil
				} else {
					body["lastName"] = lastName
				}
			}
			if len(body) == 0 {
				return errors.New("nothing to update: pass --username, --first-name or --last-name")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/auth/me", body, &raw); err != nil {
				return err
			}
			output.Successf("updated profile")
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&username, "username", "", "new username (must be unique)")
	c.Flags().StringVar(&firstName, "first-name", "", `new first name ("" to clear)`)
	c.Flags().StringVar(&lastName, "last-name", "", `new last name ("" to clear)`)
	return c
}

func userAvatarCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "avatar",
		Short: "Manage your avatar image",
	}
	c.AddCommand(userAvatarSetCmd(), userAvatarDeleteCmd())
	return c
}

func userAvatarSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <file>",
		Short: "Upload an avatar image (jpeg/png/gif/webp, max 5MB)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			f, err := os.Open(args[0])
			if err != nil {
				return err
			}
			defer f.Close()
			data, err := cl.Upload(cmd.Context(), "/auth/me/avatar", "file", filepath.Base(args[0]), f)
			if err != nil {
				return err
			}
			output.Successf("uploaded avatar")
			if fmtFlag() == output.FormatJSON {
				output.Raw(data)
			}
			return nil
		},
	}
}

func userAvatarDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete",
		Aliases: []string{"rm"},
		Short:   "Remove your avatar",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm("delete your avatar image", yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/auth/me/avatar", nil, nil); err != nil {
				return err
			}
			output.Successf("deleted avatar")
			return nil
		},
	}
}
