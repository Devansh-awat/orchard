package cmd

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/exitcode"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/spf13/cobra"
)

func deployCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "deploy",
		GroupID: groupResources,
		Aliases: []string{"deployment", "deployments"},
		Short:   "Manage deployments",
	}
	c.AddCommand(
		deployListCmd(),
		deployGetCmd(),
		deployCreateCmd(),
		deployDeleteCmd(),
		deployScaleCmd(),
		deployRestartCmd(),
		deployRebuildCmd(),
		deployCancelCmd(),
		deployRollbackCmd(),
		deployImageCmd(),
		deployHistoryCmd(),
		deployLogsCmd(),
		deployPodsCmd(),
		deployMetricsCmd(),
		deployEnvCmd(),
		deployResourcesCmd(),
		deployVolumesCmd(),
		deployStrategyCmd(),
		deployPullPolicyCmd(),
		deployHealthCheckCmd(),
		deployBuildRootCmd(),
		deployKilledCmd(),
		deployAutoDeployCmd(),
		deployWebhookTokenCmd(),
		deployGithubDeploymentsCmd(),
	)
	return c
}

func deployPath(id string, rest ...string) string {
	p := "/deployments/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func deployWaitRunning(id string) api.WaitSpec {
	return api.WaitSpec{
		Path:    deployPath(id),
		Field:   "status",
		Success: []string{"running"},
		Failure: []string{"failed", "error"},
	}
}

func deployWaitBuild(id string) api.WaitSpec {
	return api.WaitSpec{
		Path:    deployPath(id),
		Field:   "buildStatus",
		Success: []string{"succeeded"},
		Failure: []string{"failed"},
	}
}

func deployListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List deployments (scoped to the current project when one is set)",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			path := "/deployments"
			if scope := scopedProject(cfg); scope != "" {
				proj, rerr := resolveProject(cmd.Context(), cl, scope)
				if rerr != nil {
					return rerr
				}
				path = "/projects/" + url.PathEscape(str(proj["id"])) + "/deployments"
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, d := range asList(raw) {
				rows = append(rows, []string{
					pick(d, "id"),
					pick(d, "name", "slug"),
					output.Status(pick(d, "status", "state", "phase")),
					pick(d, "image"),
					pick(d, "replicas"),
				})
			}
			output.Table([]string{"id", "name", "status", "image", "replicas"}, rows)
			return nil
		},
	}
}

func deployGetCmd() *cobra.Command {
	var watch bool
	c := &cobra.Command{
		Use:   "get <id>",
		Short: "Show a deployment",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if watch && !output.IsTTY() {
				return &exitcode.UsageError{Err: errors.New("--watch needs an interactive terminal")}
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &raw); err != nil {
				return err
			}
			if !watch {
				if fmtFlag() == output.FormatJSON {
					return output.JSON(raw)
				}
				deployRenderKV(raw)
				return nil
			}
			refresh := func(ctx context.Context) error {
				var cur map[string]any
				if err := cl.GetJSON(ctx, deployPath(args[0]), &cur); err != nil {
					return err
				}
				fmt.Print(eventsClearScreen)
				deployRenderKV(cur)
				return nil
			}
			fmt.Print(eventsClearScreen)
			deployRenderKV(raw)
			id := str(raw["id"])
			if id == "" {
				id = args[0]
			}
			orgID := eventsOrgID(raw)
			if orgID == "" {
				return eventsWatchPoll(cmd.Context(), 5*time.Second, refresh)
			}
			return eventsWatchSSE(cmd.Context(), cl, orgID, "deployment.changed", id, refresh)
		},
	}
	c.Flags().BoolVar(&watch, "watch", false, "keep re-rendering as the deployment changes (TTY only)")
	return c
}

// deployRenderKV prints the table-mode detail view for one deployment.
func deployRenderKV(raw map[string]any) {
	pairs := [][2]string{
		{"id", pick(raw, "id")},
		{"name", pick(raw, "name")},
		{"status", output.Status(pick(raw, "status"))},
		{"build status", output.Status(pick(raw, "buildStatus"))},
		{"image", pick(raw, "image")},
		{"replicas", pick(raw, "replicas")},
		{"namespace", pick(raw, "namespace")},
		{"strategy", pick(raw, "deployStrategy")},
		{"pull policy", pick(raw, "imagePullPolicy")},
	}
	for _, opt := range [][2]string{
		{"build type", pick(raw, "buildType")},
		{"github repo", pick(raw, "githubRepo")},
		{"github branch", pick(raw, "githubBranch")},
		{"dockerfile", pick(raw, "dockerfilePath")},
		{"build from root", pick(raw, "buildFromRoot")},
		{"auto-deploy", pick(raw, "autoDeployEnabled")},
		{"auto-deploy branch", pick(raw, "autoDeployBranch")},
		{"cpu (milli)", pick(raw, "cpuRequestMilli")},
		{"memory (bytes)", pick(raw, "memoryRequestBytes")},
		{"health check", pick(raw, "healthCheckEnabled")},
		{"created", pick(raw, "createdAt")},
	} {
		if opt[1] != "" {
			pairs = append(pairs, opt)
		}
	}
	output.KV(pairs)
}

func deployCreateCmd() *cobra.Command {
	var (
		name, image, github, dockerfile, memory, envFile   string
		rootDir, installCmd, buildCmd, startCmd, outputDir string
		pullPolicy                                         string
		railpack, buildRoot, autoURL                       bool
		port, replicas, cpu                                int
		envs                                               []string
		wait                                               *bool
		timeout                                            *time.Duration
	)
	c := &cobra.Command{
		Use:   "create",
		Short: "Create a deployment from a Docker image or a GitHub repo",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if (image == "") == (github == "") {
				return errors.New("exactly one of --image or --github is required")
			}
			if image != "" && (dockerfile != "" || railpack || buildRoot) {
				return errors.New("--dockerfile, --railpack and --build-root only apply to --github deployments")
			}
			// GitHub builds get a unique tag per build, so the policy is
			// meaningless there and accepting it would just be misleading.
			if pullPolicy != "" && github != "" {
				return errors.New("--pull-policy only applies to --image deployments")
			}
			var normalizedPullPolicy string
			switch strings.ToLower(pullPolicy) {
			case "":
			case "always":
				normalizedPullPolicy = "Always"
			case "ifnotpresent":
				normalizedPullPolicy = "IfNotPresent"
			default:
				return fmt.Errorf("--pull-policy must be always or ifnotpresent, got %q", pullPolicy)
			}
			envList, err := deployEnvArgs(envs, envFile)
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

			body := map[string]any{"name": name}
			if replicas > 0 {
				body["replicas"] = replicas
			}
			if port > 0 {
				body["port"] = port
			}
			if len(envList) > 0 {
				body["env"] = envList
			}
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
			if cmd.Flags().Changed("auto-url") {
				body["autoUrl"] = autoURL
			}

			path := "/projects/" + url.PathEscape(projectID) + "/deployments"
			if github != "" {
				repo, branch, _ := strings.Cut(github, "#")
				if !strings.Contains(repo, "/") {
					return fmt.Errorf("--github expects owner/repo[#branch], got %q", github)
				}
				body["githubRepo"] = repo
				if branch != "" {
					body["branch"] = branch
				}
				if railpack {
					body["buildType"] = "railpack"
				}
				if dockerfile != "" {
					body["dockerfilePath"] = dockerfile
				}
				body["buildFromRoot"] = buildRoot
				for k, v := range map[string]string{
					"rootDirectory":   rootDir,
					"installCommand":  installCmd,
					"buildCommand":    buildCmd,
					"startCommand":    startCmd,
					"outputDirectory": outputDir,
				} {
					if v != "" {
						body[k] = v
					}
				}
				path += "/from-github"
			} else {
				body["image"] = image
				if normalizedPullPolicy != "" {
					body["imagePullPolicy"] = normalizedPullPolicy
				}
			}

			var raw map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, path, body, &raw); err != nil {
				return err
			}
			id := str(raw["id"])
			output.Successf("created deployment %s (%s)", name, id)
			if u := str(raw["url"]); u != "" {
				output.Successf("live at %s (visible to your org until made public)", u)
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(raw); err != nil {
					return err
				}
			}
			if *wait && id != "" {
				spec := deployWaitRunning(id)
				if github != "" {
					spec = deployWaitBuild(id)
				}
				if werr := runWait(cmd.Context(), cl, spec, *timeout); werr != nil {
					return werr
				}
				printDeploySuccess(cmd.Context(), cl, cfg.APIURL, id)
				return nil
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "deployment name (required)")
	c.Flags().StringVar(&image, "image", "", "Docker image reference (e.g. nginx:latest)")
	c.Flags().StringVar(&pullPolicy, "pull-policy", "", "re-pull the image on every pod start: always|ifnotpresent (--image only)")
	c.Flags().StringVar(&github, "github", "", "GitHub source as owner/repo[#branch]")
	c.Flags().StringVar(&dockerfile, "dockerfile", "", "path to the Dockerfile relative to the repo root")
	c.Flags().BoolVar(&railpack, "railpack", false, "build with railpack instead of a Dockerfile")
	c.Flags().BoolVar(&buildRoot, "build-root", false, "use the repo root as the build context")
	c.Flags().StringVar(&rootDir, "root", "", "directory of the app inside the repo (monorepos)")
	c.Flags().StringVar(&installCmd, "install-cmd", "", "override the detected install command")
	c.Flags().StringVar(&buildCmd, "build-cmd", "", "override the detected build command")
	c.Flags().StringVar(&startCmd, "start-cmd", "", "override the detected start command")
	c.Flags().StringVar(&outputDir, "output-dir", "", "directory of built static files; serves the app as a static site")
	c.Flags().BoolVar(&autoURL, "auto-url", true, "generate a platform URL for the deployment (org-protected by default)")
	c.Flags().IntVar(&port, "port", 0, "port the container listens on (server default 80 / EXPOSE autodetect)")
	c.Flags().IntVar(&replicas, "replicas", 0, "number of replicas (server default 1)")
	c.Flags().StringArrayVar(&envs, "env", nil, "environment variable KEY=VAL (repeatable)")
	c.Flags().StringVar(&envFile, "env-file", "", "read environment variables from a dotenv-style file")
	c.Flags().IntVar(&cpu, "cpu", 0, "CPU request in millicores (e.g. 500)")
	c.Flags().StringVar(&memory, "memory", "", `memory request in bytes or with unit (e.g. "512Mi")`)
	_ = c.MarkFlagRequired("name")
	wait, timeout = addWaitFlags(c)
	return c
}

// deployEnvArgs merges --env-file and --env KEY=VAL values into the API env
// list shape; flag values override file values, keys are sorted for stable
// request bodies.
func deployEnvArgs(flags []string, file string) ([]map[string]any, error) {
	merged := map[string]string{}
	if file != "" {
		fromFile, err := parseEnvFile(file)
		if err != nil {
			return nil, err
		}
		maps.Copy(merged, fromFile)
	}
	fromFlags, err := parseKVArgs(flags)
	if err != nil {
		return nil, err
	}
	maps.Copy(merged, fromFlags)
	out := make([]map[string]any, 0, len(merged))
	for _, k := range slices.Sorted(maps.Keys(merged)) {
		out = append(out, map[string]any{"key": k, "value": merged[k]})
	}
	return out, nil
}

func deployDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <id>",
		Aliases: []string{"rm"},
		Short:   "Delete a deployment and its Kubernetes resources",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := output.Confirm(fmt.Sprintf("permanently delete deployment %s", args[0]), yesFlag); err != nil {
				return err
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, deployPath(args[0]), nil, nil); err != nil {
				return err
			}
			output.Successf("deleted deployment %s", args[0])
			return nil
		},
	}
}

func deployScaleCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "scale <id> <replicas>",
		Short: "Scale a deployment to N replicas",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			replicas, perr := strconv.Atoi(args[1])
			if perr != nil {
				return perr
			}
			body := map[string]any{"replicas": replicas}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "scale"), body, nil); err != nil {
				return err
			}
			output.Successf("scaled %s to %d replicas", args[0], replicas)
			if *wait {
				return runWait(cmd.Context(), cl, deployWaitRunning(args[0]), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func deployRestartCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "restart <id>",
		Short: "Restart a deployment's pods",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "restart"), nil, nil); err != nil {
				return err
			}
			output.Successf("restarted %s", args[0])
			if *wait {
				return runWait(cmd.Context(), cl, deployWaitRunning(args[0]), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func deployRebuildCmd() *cobra.Command {
	var wait *bool
	var timeout *time.Duration
	c := &cobra.Command{
		Use:   "rebuild <id>",
		Short: "Rebuild a deployment from source",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "rebuild"), nil, nil); err != nil {
				return err
			}
			output.Successf("triggered rebuild of %s", args[0])
			if *wait {
				return runWait(cmd.Context(), cl, deployWaitBuild(args[0]), *timeout)
			}
			return nil
		},
	}
	wait, timeout = addWaitFlags(c)
	return c
}

func deployCancelCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel <id>",
		Short: "Cancel an in-progress build",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodPost, deployPath(args[0], "cancel"), nil, nil); err != nil {
				return err
			}
			output.Successf("cancelled build of %s", args[0])
			return nil
		},
	}
}

func deployLogsCmd() *cobra.Command {
	var build, follow bool
	var tail int
	c := &cobra.Command{
		Use:   "logs <id>",
		Short: "Fetch runtime pod logs (or build logs with --build)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			if build {
				if follow {
					if err := followBuildLogsSSE(cmd.Context(), cl, args[0]); !errors.Is(err, errSSEUnsupported) {
						return err
					}
					fetch := func(ctx context.Context) (string, error) {
						var lr map[string]any
						if err := cl.GetJSON(ctx, deployPath(args[0], "logs"), &lr); err != nil {
							return "", err
						}
						return str(lr["logs"]), nil
					}
					return followLines(cmd.Context(), 3*time.Second, fetch, os.Stdout)
				}
				res, derr := cl.Do(cmd.Context(), http.MethodGet, deployPath(args[0], "logs"), nil)
				if derr != nil {
					return derr
				}
				output.Raw(res)
				return nil
			}
			var dep map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0]), &dep); err != nil {
				return err
			}
			ns := str(dep["namespace"])
			if ns == "" {
				return errors.New("deployment has no namespace; use --build for build logs")
			}
			if follow {
				if err := followRuntimeLogsSSE(cmd.Context(), cl, args[0], tail); !errors.Is(err, errSSEUnsupported) {
					return err
				}
				return deployFollowPodLogs(cmd.Context(), cl, args[0], ns, tail)
			}
			var podsRaw any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "pods"), &podsRaw); err != nil {
				return err
			}
			pods := asList(podsRaw)
			if len(pods) == 0 {
				output.Warnf("no pods found for deployment %s", args[0])
				return nil
			}
			entries := []map[string]any{}
			for _, p := range pods {
				podName := pick(p, "name")
				if podName == "" {
					continue
				}
				q := url.Values{"namespace": {ns}, "tailLines": {strconv.Itoa(tail)}}
				var lr map[string]any
				if err := cl.GetJSON(cmd.Context(), "/pods/"+url.PathEscape(podName)+"/logs?"+q.Encode(), &lr); err != nil {
					return err
				}
				entries = append(entries, map[string]any{"pod": podName, "container": lr["container"], "logs": lr["logs"]})
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(entries)
			}
			for _, e := range entries {
				if len(entries) > 1 {
					fmt.Println(output.Dim("── pod " + str(e["pod"])))
				}
				logs := str(e["logs"])
				fmt.Print(logs)
				if logs != "" && !strings.HasSuffix(logs, "\n") {
					fmt.Println()
				}
			}
			return nil
		},
	}
	c.Flags().BoolVar(&build, "build", false, "fetch build logs instead of runtime pod logs")
	c.Flags().BoolVarP(&follow, "follow", "f", false, "keep polling for new log lines until interrupted")
	c.Flags().IntVar(&tail, "tail", 100, "lines of recent logs per pod")
	return c
}

// deployFollowPodLogs re-polls the pod list and each pod's log tail every 3s,
// emitting only newly-appended lines per pod (diffAppend, same strategy as
// followLines but with one overlap window per pod).
func deployFollowPodLogs(ctx context.Context, cl *api.Client, id, ns string, tail int) error {
	prev := map[string]string{}
	for {
		var podsRaw any
		if err := cl.GetJSON(ctx, deployPath(id, "pods"), &podsRaw); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		pods := asList(podsRaw)
		for _, p := range pods {
			podName := pick(p, "name")
			if podName == "" {
				continue
			}
			q := url.Values{"namespace": {ns}, "tailLines": {strconv.Itoa(tail)}}
			var lr map[string]any
			if err := cl.GetJSON(ctx, "/pods/"+url.PathEscape(podName)+"/logs?"+q.Encode(), &lr); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			cur := str(lr["logs"])
			delta := diffAppend(prev[podName], cur)
			prev[podName] = cur
			if delta == "" {
				continue
			}
			if len(pods) > 1 {
				fmt.Println(output.Dim("── pod " + podName))
			}
			fmt.Print(strings.TrimSuffix(delta, "\n") + "\n")
		}
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
			return nil
		}
	}
}

func deployPodsCmd() *cobra.Command {
	var live bool
	c := &cobra.Command{
		Use:   "pods <id>",
		Short: "List a deployment's pods",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			path := deployPath(args[0], "pods")
			if live {
				path = deployPath(args[0], "pods-live")
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			list := asList(raw)
			if len(list) == 0 {
				// pods-live wraps the array: {"pods": [...], "warnings": [...]}
				if m, ok := raw.(map[string]any); ok {
					list = asList(m["pods"])
				}
			}
			rows := [][]string{}
			for _, p := range list {
				rows = append(rows, []string{
					pick(p, "name"),
					output.Status(pick(p, "status", "phase")),
					pick(p, "ip", "podIp"),
					pick(p, "nodeName", "node"),
					pick(p, "restartCount", "restarts"),
				})
			}
			output.Table([]string{"name", "status", "ip", "node", "restarts"}, rows)
			return nil
		},
	}
	c.Flags().BoolVar(&live, "live", false, "query the cluster directly (includes usage and warnings)")
	return c
}

func deployMetricsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "metrics <id>",
		Short: "Show CPU/memory/network metrics for the last hour",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), deployPath(args[0], "metrics"), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			data, _ := raw["data"].(map[string]any)
			output.KV([][2]string{
				{"cpu (millicores)", deployMetricLatest(data["cpu"])},
				{"memory (MB)", deployMetricLatest(data["mem"])},
				{"net rx (KB/s)", deployMetricLatest(data["rx"])},
				{"net tx (KB/s)", deployMetricLatest(data["tx"])},
			})
			return nil
		},
	}
}

func deployMetricLatest(v any) string {
	pts, ok := v.([]any)
	if !ok || len(pts) == 0 {
		return "-"
	}
	m, ok := pts[len(pts)-1].(map[string]any)
	if !ok {
		return "-"
	}
	y, ok := m["y"].(float64)
	if !ok {
		return "-"
	}
	return strconv.FormatFloat(y, 'f', 1, 64)
}
