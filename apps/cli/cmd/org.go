package cmd

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func orgCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "org",
		GroupID: groupResources,
		Aliases: []string{"orgs", "organization", "organizations"},
		Short:   "Manage organizations",
	}
	c.AddCommand(
		orgListCmd(),
		orgGetCmd(),
		orgUpdateCmd(),
		orgAvatarCmd(),
		orgBackupSettingsCmd(),
		orgRegistryCmd(),
	)
	return c
}

func orgListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List organizations you belong to",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/organizations/user", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, o := range asList(raw) {
				rows = append(rows, []string{
					pick(o, "id"),
					pick(o, "slug"),
					pick(o, "name"),
					pick(o, "plan"),
					pick(o, "subdomain"),
				})
			}
			output.Table([]string{"id", "slug", "name", "plan", "subdomain"}, rows)
			return nil
		},
	}
}

func orgGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get [slug-or-id]",
		Short: "Show an organization (defaults to the current scope)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			target := scopedOrg(cfg)
			if len(args) == 1 {
				target = args[0]
			}
			if target == "" {
				return errors.New("no organization scope: pass an organization argument, --org, or run `orchard use org <slug>`")
			}
			m, err := resolveOrg(cmd.Context(), cl, target)
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(m)
			}
			pairs := [][2]string{
				{"id", str(m["id"])},
				{"slug", str(m["slug"])},
				{"name", str(m["name"])},
			}
			for _, f := range [][2]string{
				{"plan", "plan"},
				{"subdomain", "subdomain"},
				{"description", "description"},
				{"public ip", "databasePublicIp"},
				{"created", "createdAt"},
			} {
				if v := pick(m, f[1]); v != "" {
					pairs = append(pairs, [2]string{f[0], v})
				}
			}
			output.KV(pairs)
			return nil
		},
	}
}

func orgUpdateCmd() *cobra.Command {
	var name, publicIP, subdomain string
	var pgAutoUpdate bool
	c := &cobra.Command{
		Use:   "update <slug-or-id>",
		Short: "Update an organization",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if !cmd.Flags().Changed("name") && !cmd.Flags().Changed("public-ip") && !cmd.Flags().Changed("subdomain") && !cmd.Flags().Changed("postgres-auto-update") {
				return errors.New("nothing to update: pass --name, --public-ip, --subdomain, or --postgres-auto-update")
			}
			m, err := resolveOrg(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			id := str(m["id"])
			body := map[string]any{}
			if cmd.Flags().Changed("name") {
				body["name"] = name
			}
			if cmd.Flags().Changed("public-ip") {
				if publicIP == "" {
					body["databasePublicIp"] = nil
				} else {
					body["databasePublicIp"] = publicIP
				}
			}
			if cmd.Flags().Changed("postgres-auto-update") {
				body["postgresAutoUpdate"] = pgAutoUpdate
			}
			if len(body) > 0 {
				if err := cl.Send(cmd.Context(), http.MethodPatch, "/organizations/"+url.PathEscape(id), body, nil); err != nil {
					return err
				}
			}
			if cmd.Flags().Changed("subdomain") {
				// subdomain has its own endpoint (owner + enterprise plan enforced server-side)
				var sub any
				if subdomain != "" {
					sub = subdomain
				}
				if err := cl.Send(cmd.Context(), http.MethodPatch, "/organizations/"+url.PathEscape(id)+"/subdomain", map[string]any{"subdomain": sub}, nil); err != nil {
					return err
				}
			}
			output.Successf("updated organization %s", pick(m, "slug", "id"))
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "new display name")
	c.Flags().StringVar(&publicIP, "public-ip", "", "public IP advertised for exposed databases (empty to clear)")
	c.Flags().StringVar(&subdomain, "subdomain", "", "custom subdomain (empty to clear)")
	c.Flags().BoolVar(&pgAutoUpdate, "postgres-auto-update", false, "let Orchard roll Postgres minor updates on this organization's databases (admins only)")
	return c
}

func orgAvatarCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "avatar",
		Short: "Manage the organization avatar",
	}
	c.AddCommand(orgAvatarSetCmd(), orgAvatarDeleteCmd())
	return c
}

func orgAvatarSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <slug-or-id> <file>",
		Short: "Upload an organization avatar image",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			m, err := resolveOrg(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			f, err := os.Open(args[1])
			if err != nil {
				return err
			}
			defer f.Close()
			path := "/organizations/" + url.PathEscape(str(m["id"])) + "/avatar"
			if _, err := cl.Upload(cmd.Context(), path, "file", filepath.Base(args[1]), f); err != nil {
				return err
			}
			output.Successf("uploaded avatar for %s", pick(m, "slug", "id"))
			return nil
		},
	}
}

func orgAvatarDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <slug-or-id>",
		Aliases: []string{"rm"},
		Short:   "Remove the organization avatar",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			m, err := resolveOrg(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if err := output.Confirm("delete the avatar for organization "+pick(m, "slug", "id"), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, "/organizations/"+url.PathEscape(str(m["id"]))+"/avatar", nil, nil); err != nil {
				return err
			}
			output.Successf("deleted avatar for %s", pick(m, "slug", "id"))
			return nil
		},
	}
}

func orgBackupSettingsCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "backup-settings",
		Aliases: []string{"backups"},
		Short:   "Organization-wide R2 settings for database backups",
	}
	c.AddCommand(orgBackupSettingsGetCmd(), orgBackupSettingsSetCmd())
	return c
}

func orgBackupSettingsGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get",
		Short: "Show the scoped organization's backup settings",
		Args:  cobra.NoArgs,
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
			if err := cl.GetJSON(cmd.Context(), "/organizations/"+url.PathEscape(orgID)+"/backup-settings", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			m, _ := raw.(map[string]any)
			accessKey := "not set"
			if b, _ := m["accessKeyConfigured"].(bool); b {
				accessKey = "configured"
				if last4 := str(m["accessKeyLast4"]); last4 != "" {
					accessKey = "configured (ends in " + last4 + ")"
				}
			}
			secretKey := "not set"
			if b, _ := m["secretKeyConfigured"].(bool); b {
				secretKey = "configured"
			}
			output.KV([][2]string{
				{"endpoint", str(m["endpoint"])},
				{"bucket", str(m["bucket"])},
				{"region", str(m["region"])},
				{"access key", accessKey},
				{"secret key", secretKey},
				{"public ip", str(m["databasePublicIp"])},
			})
			return nil
		},
	}
}

func orgBackupSettingsSetCmd() *cobra.Command {
	var endpoint, bucket, region, accessKey, secretKey string
	c := &cobra.Command{
		Use:   "set",
		Short: "Update the scoped organization's backup settings",
		Long: "Update R2 backup settings on the scoped organization.\n\n" +
			"Credentials are write-only: omit --access-key/--secret-key to keep the\n" +
			"stored values, pass an empty string to clear them.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			// backup settings ride on PATCH /organizations/:id; there is no dedicated write endpoint
			body := map[string]any{}
			set := func(flag, key, val string) {
				if !cmd.Flags().Changed(flag) {
					return
				}
				if val == "" {
					body[key] = nil
				} else {
					body[key] = val
				}
			}
			set("endpoint", "backupR2Endpoint", endpoint)
			set("bucket", "backupR2Bucket", bucket)
			set("region", "backupR2Region", region)
			set("access-key", "backupR2AccessKey", accessKey)
			set("secret-key", "backupR2SecretKey", secretKey)
			if len(body) == 0 {
				return errors.New("nothing to set: pass --endpoint, --bucket, --region, --access-key, or --secret-key")
			}
			orgID, err := requireOrg(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPatch, "/organizations/"+url.PathEscape(orgID), body, nil); err != nil {
				return err
			}
			output.Successf("updated backup settings")
			return nil
		},
	}
	c.Flags().StringVar(&endpoint, "endpoint", "", "R2 endpoint, e.g. https://<account-id>.r2.cloudflarestorage.com (empty to clear)")
	c.Flags().StringVar(&bucket, "bucket", "", "R2 bucket name (empty to clear)")
	c.Flags().StringVar(&region, "region", "", "R2 region, usually auto (empty to clear)")
	c.Flags().StringVar(&accessKey, "access-key", "", "R2 access key id (write-only; empty to clear)")
	c.Flags().StringVar(&secretKey, "secret-key", "", "R2 secret access key (write-only; empty to clear)")
	return c
}
