package cmd

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

func templateCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "template",
		GroupID: groupResources,
		Aliases: []string{"templates", "tpl"},
		Short:   "Deploy prebuilt app stacks from templates",
	}
	c.AddCommand(
		templateListCmd(),
		templateGetCmd(),
		templateDeployCmd(),
		templateInstanceCmd(),
		templateAdminCmd(),
	)
	return c
}

func templatePath(id string) string { return "/templates/" + url.PathEscape(id) }

func templateInstancePath(id string) string { return "/template-instances/" + url.PathEscape(id) }

func templateInner(m map[string]any, key string) map[string]any {
	inner, _ := m[key].(map[string]any)
	return inner
}

func templateStrList(v any) string {
	items, _ := v.([]any)
	parts := []string{}
	for _, it := range items {
		if s, ok := it.(string); ok && s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ", ")
}

func templateSection(title string, headers []string, rows [][]string) {
	if len(rows) == 0 {
		return
	}
	fmt.Println()
	fmt.Println(output.Dim(title))
	output.Table(headers, rows)
}

func templateListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List available templates",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/templates", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, t := range asList(raw) {
				rows = append(rows, []string{
					pick(t, "id"),
					pick(t, "name"),
					pick(t, "displayName"),
					pick(t, "category"),
					pick(t, "version"),
					pick(t, "isBuiltIn"),
				})
			}
			output.Table([]string{"id", "name", "display name", "category", "version", "built-in"}, rows)
			return nil
		},
	}
}

func templateGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a template with its parameters and resources",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), templatePath(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			pairs := [][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"display name", pick(raw, "displayName")},
			}
			for _, opt := range [][2]string{
				{"description", pick(raw, "description")},
				{"version", pick(raw, "version")},
				{"category", pick(raw, "category")},
				{"tags", templateStrList(raw["tags"])},
				{"built-in", pick(raw, "isBuiltIn")},
				{"created", pick(raw, "createdAt")},
			} {
				if opt[1] != "" {
					pairs = append(pairs, opt)
				}
			}
			output.KV(pairs)
			paramRows := [][]string{}
			for _, p := range asList(raw["parameters"]) {
				paramRows = append(paramRows, []string{
					pick(p, "name"),
					pick(p, "type"),
					pick(p, "required"),
					pick(p, "default"),
					pick(p, "description"),
				})
			}
			templateSection("parameters", []string{"name", "type", "required", "default", "description"}, paramRows)
			resRows := [][]string{}
			for _, r := range asList(raw["resources"]) {
				resRows = append(resRows, []string{pick(r, "name"), pick(r, "type")})
			}
			templateSection("resources", []string{"name", "type"}, resRows)
			return nil
		},
	}
}

func templateDeployCmd() *cobra.Command {
	var (
		params []string
		cpu    int
		memory string
	)
	c := &cobra.Command{
		Use:   "deploy <templateId>",
		Short: "Deploy a template into the current project",
		Long: "Create every resource the template defines (databases, deployments,\n" + "domains) in the current project and connect them.\n\n" +
			"Run `orchard template get <id>` to see the expected parameters. Secret\n" +
			"parameters are generated server-side when omitted. The request returns\n" +
			"once every resource exists, so there is nothing to poll for.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			paramMap, err := parseKVArgs(params)
			if err != nil {
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
			body := map[string]any{"templateId": args[0], "parameters": paramMap}
			if cpu > 0 {
				body["cpuRequestMilli"] = cpu
			}
			if memory != "" {
				b, perr := dbParseMemory(memory)
				if perr != nil {
					return perr
				}
				body["memoryRequestBytes"] = b
			}
			path := "/projects/" + url.PathEscape(projectID) + "/template-instances"
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, path, body, &raw); err != nil {
				return err
			}
			output.Successf("deployed template %s as instance %s (%s)", args[0], str(raw["id"]), pick(raw, "status"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringArrayVar(&params, "param", nil, "template parameter KEY=VAL (repeatable)")
	c.Flags().IntVar(&cpu, "cpu", 0, "CPU request override in millicores for created resources")
	c.Flags().StringVar(&memory, "memory", "", `memory request override in bytes or with unit (e.g. "512Mi")`)
	return c
}

func templateInstanceCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "instance",
		Aliases: []string{"instances"},
		Short:   "Manage deployed template instances",
	}
	c.AddCommand(
		templateInstanceListCmd(),
		templateInstanceGetCmd(),
		templateInstanceDeleteCmd(),
	)
	return c
}

func templateInstanceListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List template instances in the current project",
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
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID)+"/template-instances", &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, in := range asList(raw) {
				tpl := templateInner(in, "template")
				total := len(asList(in["deployments"])) + len(asList(in["databases"])) + len(asList(in["ingresses"]))
				rows = append(rows, []string{
					pick(in, "id"),
					pick(in, "name"),
					pick(tpl, "displayName", "name"),
					output.Status(pick(in, "status")),
					strconv.Itoa(total),
					pick(in, "createdAt"),
				})
			}
			output.Table([]string{"id", "name", "template", "status", "resources", "created"}, rows)
			return nil
		},
	}
}

func templateInstanceGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show a template instance and the resources it created",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), templateInstancePath(args[0]), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			tpl := templateInner(raw, "template")
			output.KV([][2]string{
				{"id", pick(raw, "id")},
				{"name", pick(raw, "name")},
				{"status", output.Status(pick(raw, "status"))},
				{"template", pick(tpl, "displayName", "name")},
				{"project", pick(raw, "projectId")},
				{"created", pick(raw, "createdAt")},
			})
			depRows := [][]string{}
			for _, d := range asList(raw["deployments"]) {
				depRows = append(depRows, []string{
					pick(d, "id"),
					pick(d, "name"),
					output.Status(pick(d, "status")),
					pick(d, "image"),
				})
			}
			templateSection("deployments", []string{"id", "name", "status", "image"}, depRows)
			dbRows := [][]string{}
			for _, d := range asList(raw["databases"]) {
				dbRows = append(dbRows, []string{
					pick(d, "id"),
					pick(d, "name"),
					output.Status(pick(d, "status")),
					pick(d, "dbName"),
				})
			}
			templateSection("databases", []string{"id", "name", "status", "database"}, dbRows)
			ingRows := [][]string{}
			for _, i := range asList(raw["ingresses"]) {
				ingRows = append(ingRows, []string{
					pick(i, "id"),
					pick(i, "name"),
					pick(i, "host"),
					pick(i, "path"),
				})
			}
			templateSection("ingresses", []string{"id", "name", "host", "path"}, ingRows)
			return nil
		},
	}
}

func templateInstanceDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a template instance and every resource it created",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("delete template instance %s and every resource it created", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, templateInstancePath(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted template instance %s", args[0])
			return nil
		},
	}
}

func templateAdminCmd() *cobra.Command {
	c := &cobra.Command{
		Use:    "admin",
		Hidden: true,
		Short:  "Manage template definitions (superadmin only)",
		Long: "Create, update and delete template definitions. The server restricts\n" +
			"these endpoints to superadmins; everyone else gets a 404.",
	}
	c.AddCommand(
		templateAdminCreateCmd(),
		templateAdminUpdateCmd(),
		templateAdminDeleteCmd(),
	)
	return c
}

func templateAdminCreateCmd() *cobra.Command {
	var file string
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a template from a YAML definition file",
		Long: "POST the raw YAML definition (leaf/v1 format: metadata, parameters,\n" +
			"resources). The MCP tool get_template_yaml_guide documents the format.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"yaml": string(data)}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/templates", body, &raw); err != nil {
				return err
			}
			output.Successf("created template %s (%s)", pick(raw, "name"), pick(raw, "id"))
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&file, "file", "", "path to the template YAML definition (required)")
	_ = c.MarkFlagRequired("file")
	return c
}

func templateAdminUpdateCmd() *cobra.Command {
	var file string
	c := &cobra.Command{
		Use:   "update <id>",
		Short: "Replace a template's YAML definition (built-ins can't be updated)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"yaml": string(data)}
			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPut, templatePath(args[0]), body, &raw); err != nil {
				return err
			}
			output.Successf("updated template %s", args[0])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			return nil
		},
	}
	c.Flags().StringVar(&file, "file", "", "path to the template YAML definition (required)")
	_ = c.MarkFlagRequired("file")
	return c
}

func templateAdminDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a template (fails while instances of it exist)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete template %s", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, templatePath(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted template %s", args[0])
			return nil
		},
	}
}
