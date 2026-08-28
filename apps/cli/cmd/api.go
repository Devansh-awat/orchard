package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

// apiCmd is the raw escape hatch: it can reach every /apiv1 endpoint, so the CLI
// has full parity with the UI/MCP even before a friendly wrapper exists. Ideal
// for scripting and AI agents.
func apiCmd() *cobra.Command {
	var data string
	c := &cobra.Command{
		Use:     "api <METHOD> <path>",
		GroupID: groupUtility,
		Short:   "Make a raw authenticated request to the Orchard API",
		Long: "Call any /apiv1 endpoint directly.\n\n" +
			"Examples:\n" +
			"  orchard api GET /projects\n" +
			"  orchard api POST /deployments/abc/scale --data '{\"replicas\":3}'\n" +
			"  echo '{\"replicas\":3}' | orchard api POST /deployments/abc/scale --data -",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			method := strings.ToUpper(args[0])
			path := args[1]

			var body []byte
			if data == "-" {
				b, rerr := io.ReadAll(os.Stdin)
				if rerr != nil {
					return rerr
				}
				body = b
			} else if data != "" {
				body = []byte(data)
			}

			res, err := cl.Do(cmd.Context(), method, path, body)
			if err != nil {
				return err
			}
			output.Raw(res)
			return nil
		},
	}
	c.Flags().StringVarP(&data, "data", "d", "", "request body as JSON (use - to read from stdin)")
	return c
}

// pick returns the first present string field, for schema-flexible rendering.
func pick(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if t != "" {
					return t
				}
			case float64:
				return fmt.Sprintf("%g", t)
			case bool:
				return fmt.Sprintf("%v", t)
			}
		}
	}
	return ""
}

func asList(v any) []map[string]any {
	out := []map[string]any{}
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
	case map[string]any:
		// some endpoints wrap the array, e.g. {"data":[...]} / {"items":[...]}
		for _, k := range []string{"data", "items", "results", "projects", "deployments", "databases"} {
			if inner, ok := t[k]; ok {
				return asList(inner)
			}
		}
	}
	return out
}
