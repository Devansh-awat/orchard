package cmd

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployEnvCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "env",
		Short: "Manage a deployment's environment variables",
	}
	c.AddCommand(deployEnvGetCmd(), deployEnvSetCmd(), deployEnvUnsetCmd())
	return c
}

func deployFetchEnvVars(ctx context.Context, cl *api.Client, id string) ([]map[string]any, error) {
	var dep map[string]any
	if err := cl.GetJSON(ctx, deployPath(id), &dep); err != nil {
		return nil, err
	}
	return asList(dep["envVars"]), nil
}

func deployEnvGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show environment variables",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			vars, err := deployFetchEnvVars(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(vars)
			}
			rows := [][]string{}
			for _, v := range vars {
				secret := ""
				if v["secret"] == true {
					secret = "yes"
				}
				rows = append(rows, []string{pick(v, "key"), pick(v, "value"), secret})
			}
			output.Table([]string{"key", "value", "secret"}, rows)
			return nil
		},
	}
}

func deployEnvSetCmd() *cobra.Command {
	var file string
	var secret bool
	c := &cobra.Command{
		Use:   "set <id> [KEY=VAL ...]",
		Short: "Add or update environment variables (pods restart)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			updates := map[string]string{}
			if file != "" {
				fromFile, err := parseEnvFile(file)
				if err != nil {
					return err
				}
				maps.Copy(updates, fromFile)
			}
			fromArgs, err := parseKVArgs(args[1:])
			if err != nil {
				return err
			}
			maps.Copy(updates, fromArgs)
			if len(updates) == 0 {
				return errors.New("nothing to set: pass KEY=VAL arguments or --file")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			existing, err := deployFetchEnvVars(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			merged := []map[string]any{}
			seen := map[string]bool{}
			for _, e := range existing {
				k := str(e["key"])
				if v, ok := updates[k]; ok {
					merged = append(merged, map[string]any{"key": k, "value": v, "secret": e["secret"] == true || secret})
					seen[k] = true
				} else {
					merged = append(merged, map[string]any{"key": k, "value": e["value"], "secret": e["secret"] == true})
				}
			}
			for _, k := range slices.Sorted(maps.Keys(updates)) {
				if !seen[k] {
					merged = append(merged, map[string]any{"key": k, "value": updates[k], "secret": secret})
				}
			}
			body := map[string]any{"env": merged}
			if err := cl.Send(cmd.Context(), http.MethodPut, deployPath(args[0], "env"), body, nil); err != nil {
				return err
			}
			output.Successf("set %d env var(s) on %s (pods will restart)", len(updates), args[0])
			return nil
		},
	}
	c.Flags().StringVar(&file, "file", "", "read KEY=VAL pairs from a dotenv-style file")
	c.Flags().BoolVar(&secret, "secret", false, "store the given vars in a Kubernetes Secret")
	return c
}

func deployEnvUnsetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unset <id> KEY...",
		Short: "Remove environment variables (pods restart)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			existing, err := deployFetchEnvVars(cmd.Context(), cl, args[0])
			if err != nil {
				return err
			}
			drop := map[string]bool{}
			for _, k := range args[1:] {
				drop[k] = true
			}
			remaining := []map[string]any{}
			removed := 0
			for _, e := range existing {
				if drop[str(e["key"])] {
					removed++
					continue
				}
				remaining = append(remaining, map[string]any{"key": e["key"], "value": e["value"], "secret": e["secret"] == true})
			}
			if removed == 0 {
				return fmt.Errorf("no matching env vars on %s: %s", args[0], strings.Join(args[1:], ", "))
			}
			body := map[string]any{"env": remaining}
			if err := cl.Send(cmd.Context(), http.MethodPut, deployPath(args[0], "env"), body, nil); err != nil {
				return err
			}
			output.Successf("removed %d env var(s) from %s (pods will restart)", removed, args[0])
			return nil
		},
	}
}

func deployResourcesCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "resources",
		Short: "Manage a deployment's CPU/memory requests",
	}
	c.AddCommand(deployResourcesGetCmd(), deployResourcesSetCmd())
	return c
}

func deployResourcesGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show CPU/memory requests",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var dep map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &dep); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(map[string]any{
					"cpuRequestMilli":    dep["cpuRequestMilli"],
					"memoryRequestBytes": dep["memoryRequestBytes"],
				})
			}
			cpu := pick(dep, "cpuRequestMilli")
			if cpu == "" {
				cpu = "(org default)"
			}
			mem := pick(dep, "memoryRequestBytes")
			if mem == "" {
				mem = "(org default)"
			}
			output.KV([][2]string{
				{"cpu (millicores)", cpu},
				{"memory (bytes)", mem},
			})
			return nil
		},
	}
}

func deployResourcesSetCmd() *cobra.Command {
	var cpu int
	var memory string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Update CPU/memory requests (0 clears to the org default; pods roll)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f := cmd.Flags()
			if !f.Changed("cpu") && !f.Changed("memory") {
				return errors.New("pass --cpu and/or --memory")
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			// PATCH /resources treats an omitted field as "clear to default",
			// so read-modify-write to keep the untouched value.
			var dep map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &dep); err != nil {
				return err
			}
			body := map[string]any{
				"cpuRequestMilli":    dep["cpuRequestMilli"],
				"memoryRequestBytes": deployNormalizeMem(dep["memoryRequestBytes"]),
			}
			if f.Changed("cpu") {
				if cpu <= 0 {
					body["cpuRequestMilli"] = nil
				} else {
					body["cpuRequestMilli"] = cpu
				}
			}
			if f.Changed("memory") {
				if memory == "" || memory == "0" {
					body["memoryRequestBytes"] = nil
				} else {
					b, perr := dbParseMemory(memory)
					if perr != nil {
						return perr
					}
					body["memoryRequestBytes"] = b
				}
			}
			if err := cl.Send(cmd.Context(), http.MethodPatch, deployPath(args[0], "resources"), body, nil); err != nil {
				return err
			}
			output.Successf("updated resources on %s (pods will roll)", args[0])
			return nil
		},
	}
	c.Flags().IntVar(&cpu, "cpu", 0, "CPU request in millicores (0 clears to the default)")
	c.Flags().StringVar(&memory, "memory", "", `memory request in bytes or with unit, e.g. "512Mi" (0 clears)`)
	return c
}

// deployNormalizeMem turns a BigInt-serialized string back into a number so
// the PATCH body round-trips cleanly.
func deployNormalizeMem(v any) any {
	if s, ok := v.(string); ok {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n
		}
	}
	return v
}

func deployVolumesCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "volumes",
		Short: "Manage a deployment's volumes",
	}
	c.AddCommand(deployVolumesGetCmd(), deployVolumesSetCmd())
	return c
}

func deployVolumesGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <id>",
		Short: "Show attached volumes",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var dep map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &dep); err != nil {
				return err
			}
			vols := asList(dep["volumes"])
			if fmtFlag() == output.FormatJSON {
				return output.JSON(vols)
			}
			rows := [][]string{}
			for _, v := range vols {
				rows = append(rows, []string{
					pick(v, "name"),
					pick(v, "type"),
					pick(v, "mountPath"),
					pick(v, "storageSize"),
					pick(v, "pvcName"),
					pick(v, "readOnly"),
				})
			}
			output.Table([]string{"name", "type", "mount", "size", "pvc", "read-only"}, rows)
			return nil
		},
	}
}

func deployVolumesSetCmd() *cobra.Command {
	var volFlags []string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Replace all volumes with the given PVC volumes",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			vols := []map[string]any{}
			for _, v := range volFlags {
				mount, size, ok := strings.Cut(v, "=")
				if !ok || mount == "" || size == "" {
					return fmt.Errorf("--volume expects mountPath=size (e.g. /data=5Gi), got %q", v)
				}
				name := deployVolumeName(mount)
				vols = append(vols, map[string]any{
					"name":        name,
					"type":        "pvc",
					"mountPath":   mount,
					"pvcName":     name,
					"storageSize": size,
				})
			}
			if len(vols) == 0 {
				if err := output.Confirm(fmt.Sprintf("remove ALL volumes from deployment %s", args[0]), yesFlag); err != nil {
					return err
				}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"volumes": vols}
			if err := cl.Send(cmd.Context(), http.MethodPut, deployPath(args[0], "volumes"), body, nil); err != nil {
				return err
			}
			output.Successf("set %d volume(s) on %s", len(vols), args[0])
			return nil
		},
	}
	c.Flags().StringArrayVar(&volFlags, "volume", nil, "PVC volume as mountPath=size (repeatable); omit to remove all volumes")
	return c
}

func deployVolumeName(mountPath string) string {
	s := strings.ToLower(strings.Trim(mountPath, "/"))
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		return "data"
	}
	return name
}

func deployStrategyCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "strategy",
		Short: "Manage the Kubernetes update strategy",
	}
	c.AddCommand(deployStrategySetCmd())
	return c
}

func deployStrategySetCmd() *cobra.Command {
	var typ string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Set the update strategy (PVC-backed deployments require recreate)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var strategy string
			switch strings.ToLower(typ) {
			case "rollingupdate":
				strategy = "rollingUpdate"
			case "recreate":
				strategy = "recreate"
			default:
				return fmt.Errorf("--type must be rollingupdate or recreate, got %q", typ)
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"strategy": strategy}
			if err := cl.Send(cmd.Context(), http.MethodPatch, deployPath(args[0], "strategy"), body, nil); err != nil {
				return err
			}
			output.Successf("set strategy of %s to %s", args[0], strategy)
			return nil
		},
	}
	c.Flags().StringVar(&typ, "type", "", "update strategy: rollingupdate|recreate (required)")
	_ = c.MarkFlagRequired("type")
	return c
}

func deployPullPolicyCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "pull-policy",
		Short: "Manage whether the image is re-pulled on every pod start",
	}
	c.AddCommand(deployPullPolicySetCmd())
	return c
}

func deployPullPolicySetCmd() *cobra.Command {
	var policy string
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Set the image pull policy",
		Long: `Set the image pull policy for a deployment.

With ifnotpresent (the default) the node reuses the image layer it already has,
so pushing a new :latest and restarting changes nothing. With always, a restart
re-pulls the tag.

Only relevant for deployments pinned to a moving tag. Apps built from GitHub get
a unique tag per build.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var normalized string
			switch strings.ToLower(policy) {
			case "always":
				normalized = "Always"
			case "ifnotpresent":
				normalized = "IfNotPresent"
			default:
				return fmt.Errorf("--policy must be always or ifnotpresent, got %q", policy)
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"imagePullPolicy": normalized}
			if err := cl.Send(cmd.Context(), http.MethodPatch, deployPath(args[0], "pull-policy"), body, nil); err != nil {
				return err
			}
			output.Successf("set pull policy of %s to %s", args[0], normalized)
			return nil
		},
	}
	c.Flags().StringVar(&policy, "policy", "", "pull policy: always|ifnotpresent (required)")
	_ = c.MarkFlagRequired("policy")
	return c
}

func deployHealthCheckCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "health-check",
		Short: "Manage liveness/readiness/startup probes",
	}
	c.AddCommand(deployHealthCheckSetCmd())
	return c
}

func deployHealthCheckSetCmd() *cobra.Command {
	var (
		enabled, liveness, readiness, startup      bool
		hcType, hcPath, command                    string
		port, interval, hcTimeout, retries, thresh int
	)
	c := &cobra.Command{
		Use:   "set <id>",
		Short: "Update health check configuration (unset flags keep current values)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			// PUT /health-check replaces the whole config, so start from the
			// deployment's current values and overlay only the changed flags.
			var dep map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &dep); err != nil {
				return err
			}
			body := map[string]any{
				"healthCheckEnabled":      deployBoolField(dep, "healthCheckEnabled", false),
				"healthCheckType":         deployStrField(dep, "healthCheckType", "http"),
				"livenessEnabled":         deployBoolField(dep, "livenessEnabled", true),
				"readinessEnabled":        deployBoolField(dep, "readinessEnabled", true),
				"startupEnabled":          deployBoolField(dep, "startupEnabled", false),
				"healthCheckInterval":     deployIntField(dep, "healthCheckInterval", 30),
				"healthCheckTimeout":      deployIntField(dep, "healthCheckTimeout", 5),
				"healthCheckRetries":      deployIntField(dep, "healthCheckRetries", 3),
				"startupFailureThreshold": deployIntField(dep, "startupFailureThreshold", 30),
			}
			if v := str(dep["healthCheckPath"]); v != "" {
				body["healthCheckPath"] = v
			}
			if v, ok := dep["healthCheckPort"].(float64); ok {
				body["healthCheckPort"] = int(v)
			}
			if v := str(dep["healthCheckCommand"]); v != "" {
				body["healthCheckCommand"] = v
			}
			f := cmd.Flags()
			if f.Changed("enabled") {
				body["healthCheckEnabled"] = enabled
			}
			if f.Changed("type") {
				body["healthCheckType"] = hcType
			}
			if f.Changed("path") {
				body["healthCheckPath"] = hcPath
			}
			if f.Changed("port") {
				body["healthCheckPort"] = port
			}
			if f.Changed("command") {
				body["healthCheckCommand"] = command
			}
			if f.Changed("liveness") {
				body["livenessEnabled"] = liveness
			}
			if f.Changed("readiness") {
				body["readinessEnabled"] = readiness
			}
			if f.Changed("startup") {
				body["startupEnabled"] = startup
			}
			if f.Changed("interval") {
				body["healthCheckInterval"] = interval
			}
			if f.Changed("timeout") {
				body["healthCheckTimeout"] = hcTimeout
			}
			if f.Changed("retries") {
				body["healthCheckRetries"] = retries
			}
			if f.Changed("startup-failure-threshold") {
				body["startupFailureThreshold"] = thresh
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, deployPath(args[0], "health-check"), body, nil); err != nil {
				return err
			}
			output.Successf("updated health check on %s", args[0])
			return nil
		},
	}
	c.Flags().BoolVar(&enabled, "enabled", false, "enable or disable health checks (--enabled=false to disable)")
	c.Flags().StringVar(&hcType, "type", "", "probe type: http|tcp|exec")
	c.Flags().StringVar(&hcPath, "path", "", "HTTP probe path (e.g. /healthz)")
	c.Flags().IntVar(&port, "port", 0, "probe port")
	c.Flags().StringVar(&command, "command", "", "exec probe command")
	c.Flags().BoolVar(&liveness, "liveness", true, "enable the liveness probe")
	c.Flags().BoolVar(&readiness, "readiness", true, "enable the readiness probe")
	c.Flags().BoolVar(&startup, "startup", false, "enable the startup probe")
	c.Flags().IntVar(&interval, "interval", 0, "seconds between probes")
	c.Flags().IntVar(&hcTimeout, "timeout", 0, "probe timeout in seconds")
	c.Flags().IntVar(&retries, "retries", 0, "failures before the probe reports unhealthy")
	c.Flags().IntVar(&thresh, "startup-failure-threshold", 0, "startup probe failure threshold")
	return c
}

func deployBoolField(m map[string]any, key string, def bool) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return def
}

func deployStrField(m map[string]any, key, def string) string {
	if v := str(m[key]); v != "" {
		return v
	}
	return def
}

func deployIntField(m map[string]any, key string, def int) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return def
}

func deployBuildRootCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "build-root",
		Short: "Manage the build context of a GitHub deployment",
	}
	c.AddCommand(deployBuildRootSetCmd())
	return c
}

func deployBuildRootSetCmd() *cobra.Command {
	var depot, cache bool
	c := &cobra.Command{
		Use:   "set <id> <on|off>",
		Short: "Build from the repo root (on) or the Dockerfile directory (off)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			val, perr := deployParseOnOff(args[1])
			if perr != nil {
				return perr
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			body := map[string]any{"buildFromRoot": val}
			f := cmd.Flags()
			if f.Changed("depot") {
				body["buildWithDepot"] = depot
			}
			if f.Changed("persistent-cache") {
				body["persistentBuildCache"] = cache
			}
			if err := cl.Send(cmd.Context(), http.MethodPut, deployPath(args[0], "build-config"), body, nil); err != nil {
				return err
			}
			output.Successf("set build-from-root of %s to %v", args[0], val)
			return nil
		},
	}
	c.Flags().BoolVar(&depot, "depot", false, "build with Depot")
	c.Flags().BoolVar(&cache, "persistent-cache", false, "keep a persistent build cache between builds")
	return c
}

func deployParseOnOff(s string) (bool, error) {
	switch strings.ToLower(s) {
	case "on":
		return true, nil
	case "off":
		return false, nil
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, fmt.Errorf("expected on|off, got %q", s)
	}
	return v, nil
}
