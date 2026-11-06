package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/hackclub/orchard/cli/internal/agentspec"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var httpMethods = map[string]bool{
	"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "HEAD": true, "OPTIONS": true,
}

func isHTTPMethod(s string) bool { return httpMethods[strings.ToUpper(s)] }

func apiCmd() *cobra.Command {
	var data string
	var pathParams, queryParams []string
	c := &cobra.Command{
		Use:     "api <operationId | METHOD path>",
		GroupID: groupUtility,
		Short:   "Call any Orchard API operation, or search the API",
		Long: "Call any /apiv1 endpoint directly, by operationId or by method and path.\n\n" +
			"Discover operations with `orchard api search` and read their contract with\n" +
			"`orchard api describe`. The spec is cached in ~/.orchard/agent-spec.json and\n" +
			"revalidated with an ETag, so it works offline once fetched.\n\n" +
			"Examples:\n" +
			"  orchard api search \"deployment logs\"\n" +
			"  orchard api describe deployments_rollout_get\n" +
			"  orchard api deployments_get -p id=<uuid>\n" +
			"  orchard api deployments_rollout_get -p id=<uuid> -q wait=1 -q timeout=60\n" +
			"  orchard api deployments_env_set -p id=<uuid> -d @env.json --yes\n" +
			"  orchard api GET /projects\n" +
			"  echo '{\"replicas\":3}' | orchard api POST /deployments/abc/scale --data -",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			body, err := readBody(data)
			if err != nil {
				return err
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}

			if len(args) == 2 || isHTTPMethod(args[0]) {
				if len(args) != 2 {
					return &exitcode.UsageError{Err: fmt.Errorf("usage: orchard api METHOD /path")}
				}
				target := args[1]
				if qs := encodeQuery(queryParams); qs != "" {
					target += sep(target) + qs
				}
				res, err := cl.Do(cmd.Context(), strings.ToUpper(args[0]), target, body)
				if err != nil {
					return err
				}
				output.Raw(res)
				return nil
			}

			spec, err := loadSpec(cmd, cfg, false)
			if err != nil {
				return err
			}
			op, ok := agentspec.Find(spec.Operations, args[0])
			if !ok {
				return &exitcode.UsageError{Err: fmt.Errorf("unknown operation %q (try `orchard api search %s`)", args[0], args[0])}
			}
			params, err := parseKVArgs(pathParams)
			if err != nil {
				return &exitcode.UsageError{Err: err}
			}
			if unknown := agentspec.UnknownParams(op.Path, params); len(unknown) > 0 {
				return &exitcode.UsageError{Err: fmt.Errorf("%s has no path parameter(s) %s; it takes %s", op.OperationID, strings.Join(unknown, ", "), strings.Join(agentspec.PathParamNames(op.Path), ", "))}
			}
			path, missing := agentspec.FillPath(op.Path, params)
			if len(missing) > 0 {
				return &exitcode.UsageError{Err: fmt.Errorf("%s needs -p %s", op.OperationID, strings.Join(missingFlags(missing), " -p "))}
			}
			if op.Destructive {
				if err := output.Confirm(fmt.Sprintf("%s (%s %s) is destructive. Continue?", op.OperationID, op.Method, path), yesFlag); err != nil {
					return err
				}
			}
			if qs := encodeQuery(queryParams); qs != "" {
				path += sep(path) + qs
			}
			res, err := cl.Do(cmd.Context(), op.Method, path, body)
			if err != nil {
				return err
			}
			output.Raw(res)
			return nil
		},
	}
	c.Flags().StringVarP(&data, "data", "d", "", "request body: JSON, @file, or - to read stdin")
	c.Flags().StringArrayVarP(&pathParams, "path-param", "p", nil, "path parameter as name=value (repeatable)")
	c.Flags().StringArrayVarP(&queryParams, "query", "q", nil, "query parameter as name=value (repeatable)")
	c.AddCommand(apiSearchCmd(), apiDescribeCmd())
	return c
}

func apiSearchCmd() *cobra.Command {
	var limit int
	var refresh bool
	c := &cobra.Command{
		Use:   "search <query...>",
		Short: "Find API operations by keywords",
		Long: "Rank every Orchard API operation against a few keywords and print the best matches.\n\n" +
			"Examples:\n" +
			"  orchard api search restart deployment\n" +
			"  orchard api search \"database connection\" -o json | jq -r '.[0].operationId'",
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			spec, err := loadSpec(cmd, cfg, refresh)
			if err != nil {
				return err
			}
			hits := agentspec.Search(spec.Operations, strings.Join(args, " "), limit)
			if fmtFlag() == output.FormatJSON {
				return output.JSON(hits)
			}
			if len(hits) == 0 {
				output.Warnf("no operations match %q", strings.Join(args, " "))
				return nil
			}
			rows := make([][]string, 0, len(hits))
			for _, h := range hits {
				rows = append(rows, []string{h.OperationID, h.Method, h.Path, flagsLabel(h.Sensitive, h.Destructive), h.Summary})
			}
			output.Table([]string{"OPERATION", "METHOD", "PATH", "FLAGS", "SUMMARY"}, rows)
			return nil
		},
	}
	c.Flags().IntVar(&limit, "limit", 10, "maximum results")
	c.Flags().BoolVar(&refresh, "refresh", false, "revalidate the cached spec first")
	return c
}

func apiDescribeCmd() *cobra.Command {
	var refresh bool
	c := &cobra.Command{
		Use:   "describe <operationId | METHOD path>",
		Short: "Show an operation's params, body and response schema",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			spec, err := loadSpec(cmd, cfg, refresh)
			if err != nil {
				return err
			}
			ref := strings.Join(args, " ")
			op, ok := agentspec.Find(spec.Operations, ref)
			if !ok {
				return &exitcode.UsageError{Err: fmt.Errorf("unknown operation %q (try `orchard api search`)", ref)}
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(op)
			}
			printOperation(op)
			return nil
		},
	}
	c.Flags().BoolVar(&refresh, "refresh", false, "revalidate the cached spec first")
	return c
}

func loadSpec(cmd *cobra.Command, cfg *config.Config, refresh bool) (*agentspec.Spec, error) {
	path, err := agentspec.DefaultCachePath()
	if err != nil {
		return nil, err
	}
	loader := &agentspec.Loader{APIURL: cfg.APIURL, CachePath: path, Refresh: refresh}
	return loader.Load(cmd.Context())
}

func readBody(data string) ([]byte, error) {
	switch {
	case data == "":
		return nil, nil
	case data == "-":
		return io.ReadAll(os.Stdin)
	case strings.HasPrefix(data, "@"):
		b, err := os.ReadFile(strings.TrimPrefix(data, "@"))
		if err != nil {
			return nil, &exitcode.UsageError{Err: err}
		}
		return b, nil
	default:
		return []byte(data), nil
	}
}

func encodeQuery(pairs []string) string {
	q := url.Values{}
	for _, pair := range pairs {
		k, v, _ := strings.Cut(pair, "=")
		if k != "" {
			q.Add(k, v)
		}
	}
	return q.Encode()
}

func sep(path string) string {
	if strings.Contains(path, "?") {
		return "&"
	}
	return "?"
}

func missingFlags(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = n + "=..."
	}
	return out
}

func flagsLabel(sensitive, destructive bool) string {
	parts := []string{}
	if sensitive {
		parts = append(parts, "sensitive")
	}
	if destructive {
		parts = append(parts, "destructive")
	}
	return strings.Join(parts, ",")
}

func printOperation(op agentspec.Operation) {
	pairs := [][2]string{
		{"operationId", op.OperationID},
		{"request", op.Method + " " + op.Path},
		{"scope", op.Scope},
	}
	if op.Summary != "" {
		pairs = append(pairs, [2]string{"summary", op.Summary})
	}
	if label := flagsLabel(op.Sensitive, op.Destructive); label != "" {
		pairs = append(pairs, [2]string{"flags", label})
	}
	if op.Params != nil {
		for _, p := range op.Params.Path {
			pairs = append(pairs, [2]string{"path param", fmt.Sprintf("%s (-p %s=...)", p.Name, p.Name)})
		}
		for _, p := range op.Params.Query {
			req := ""
			if p.Required {
				req = ", required"
			}
			pairs = append(pairs, [2]string{"query param", fmt.Sprintf("%s (%s%s)", p.Name, schemaType(p.Schema), req)})
		}
	}
	output.KV(pairs)
	if len(op.RequestBody) > 0 {
		output.Println("\nrequest body:")
		output.Raw(op.RequestBody)
	}
	if len(op.Response) > 0 {
		output.Println("\nresponse:")
		output.Raw(op.Response)
	}
}

func schemaType(raw json.RawMessage) string {
	var s struct {
		Type any `json:"type"`
	}
	if json.Unmarshal(raw, &s) != nil || s.Type == nil {
		return "any"
	}
	return fmt.Sprint(s.Type)
}

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

func joinStrings(v any) string {
	items, ok := v.([]any)
	if !ok {
		return ""
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, ", ")
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
		for _, k := range []string{"data", "items", "results", "projects", "deployments", "databases"} {
			if inner, ok := t[k]; ok {
				return asList(inner)
			}
		}
	}
	return out
}
