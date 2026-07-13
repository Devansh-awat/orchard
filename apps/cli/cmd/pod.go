package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/LeafdTK/leaf/cli/internal/config"
	"github.com/LeafdTK/leaf/cli/internal/output"
	"github.com/LeafdTK/leaf/cli/internal/termsession"
	"github.com/spf13/cobra"
)

func podCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "pod",
		GroupID: groupResources,
		Aliases: []string{"pods"},
		Short:   "Inspect and interact with running pods",
	}
	c.AddCommand(
		podListCmd(),
		podGetCmd(),
		podLogsCmd(),
		podDeleteCmd(),
		podExecCmd(),
		podShellCmd(),
	)
	return c
}

func addNamespaceFlag(c *cobra.Command) *string {
	return c.Flags().StringP("namespace", "n", "", "kubernetes namespace (default: the scoped project's namespace)")
}

// podNamespace resolves the namespace for pod endpoints: explicit flag first,
// then the scoped environment's namespace, then the scoped project's.
func podNamespace(ctx context.Context, cl *api.Client, cfg *config.Config, flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	v := scopedProject(cfg)
	if v == "" {
		return "", errors.New("no namespace: pass --namespace or set a project scope (--project / `orchard use project <slug>`)")
	}
	proj, err := resolveProject(ctx, cl, v)
	if err != nil {
		return "", err
	}
	if e := scopedEnv(cfg); e != "" {
		env, err := resolveEnv(ctx, cl, str(proj["id"]), e)
		if err != nil {
			return "", err
		}
		if ns := str(env["namespace"]); ns != "" {
			return ns, nil
		}
	}
	ns := str(proj["namespace"])
	if ns == "" {
		return "", fmt.Errorf("project %q has no namespace", v)
	}
	return ns, nil
}

// podItems unwraps the list response ({namespace, podCount, pods: [...]}).
func podItems(raw any) []map[string]any {
	if m, ok := raw.(map[string]any); ok {
		if inner, ok := m["pods"]; ok {
			return asList(inner)
		}
	}
	return asList(raw)
}

func containerSummary(v any) (ready, restarts string) {
	cs, _ := v.([]any)
	total, readyN, restartN := 0, 0, 0
	for _, c := range cs {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		total++
		if r, _ := m["ready"].(bool); r {
			readyN++
		}
		if f, ok := m["restartCount"].(float64); ok {
			restartN += int(f)
		}
	}
	return fmt.Sprintf("%d/%d", readyN, total), strconv.Itoa(restartN)
}

func podListCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List pods in a namespace",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			var raw any
			if err := cl.GetJSON(cmd.Context(), "/pods?namespace="+url.QueryEscape(ns), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, p := range podItems(raw) {
				ready, restarts := containerSummary(p["containerStatuses"])
				rows = append(rows, []string{
					pick(p, "name"),
					output.Status(pick(p, "status", "phase")),
					ready,
					restarts,
					pick(p, "podIP"),
					pick(p, "startTime"),
				})
			}
			output.Table([]string{"name", "status", "ready", "restarts", "ip", "started"}, rows)
			return nil
		},
	}
	addNamespaceFlag(c)
	return c
}

func podGetCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "get <name>",
		Short: "Show a pod's status, containers, and node",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			var raw map[string]any
			path := "/pods/" + url.PathEscape(args[0]) + "?namespace=" + url.QueryEscape(ns)
			if err := cl.GetJSON(cmd.Context(), path, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			meta, _ := raw["metadata"].(map[string]any)
			spec, _ := raw["spec"].(map[string]any)
			status, _ := raw["status"].(map[string]any)
			pairs := [][2]string{
				{"name", str(meta["name"])},
				{"namespace", str(meta["namespace"])},
				{"phase", output.Status(str(status["phase"]))},
				{"node", str(spec["nodeName"])},
				{"ip", str(status["podIP"])},
				{"started", str(status["startTime"])},
			}
			totalRestarts := 0
			cs, _ := status["containerStatuses"].([]any)
			containerPairs := [][2]string{}
			for _, c := range cs {
				m, ok := c.(map[string]any)
				if !ok {
					continue
				}
				restartCount := 0
				if f, ok := m["restartCount"].(float64); ok {
					restartCount = int(f)
				}
				totalRestarts += restartCount
				ready, _ := m["ready"].(bool)
				containerPairs = append(containerPairs, [2]string{
					"container " + str(m["name"]),
					fmt.Sprintf("%s ready=%v restarts=%d", output.Status(containerState(m["state"])), ready, restartCount),
				})
			}
			pairs = append(pairs, [2]string{"restarts", strconv.Itoa(totalRestarts)})
			output.KV(append(pairs, containerPairs...))
			return nil
		},
	}
	addNamespaceFlag(c)
	return c
}

// containerState flattens a k8s container state ({running:{}} /
// {waiting:{reason}} / {terminated:{reason}}) into one word.
func containerState(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return "unknown"
	}
	for _, k := range []string{"running", "waiting", "terminated"} {
		detail, ok := m[k].(map[string]any)
		if !ok {
			continue
		}
		if reason := str(detail["reason"]); reason != "" {
			return reason
		}
		return k
	}
	return "unknown"
}

func podLogsCmd() *cobra.Command {
	var container string
	var tail int
	var previous, follow bool
	c := &cobra.Command{
		Use:   "logs <name>",
		Short: "Fetch runtime logs from a pod",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			q := url.Values{"namespace": {ns}, "tailLines": {strconv.Itoa(tail)}}
			if container != "" {
				q.Set("container", container)
			}
			if previous {
				q.Set("previous", "true")
			}
			if follow {
				fetch := func(ctx context.Context) (string, error) {
					var lr map[string]any
					if err := cl.GetJSON(ctx, "/pods/"+url.PathEscape(args[0])+"/logs?"+q.Encode(), &lr); err != nil {
						return "", err
					}
					return str(lr["logs"]), nil
				}
				return followLines(cmd.Context(), 3*time.Second, fetch, os.Stdout)
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), "/pods/"+url.PathEscape(args[0])+"/logs?"+q.Encode(), &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			logs := str(raw["logs"])
			if logs == "" {
				if msg := str(raw["message"]); msg != "" {
					output.Warnf("%s", msg)
				}
				return nil
			}
			fmt.Print(logs)
			if !strings.HasSuffix(logs, "\n") {
				fmt.Println()
			}
			return nil
		},
	}
	addNamespaceFlag(c)
	c.Flags().StringVarP(&container, "container", "c", "", "container name (default: the pod's only container)")
	c.Flags().IntVar(&tail, "tail", 100, "number of log lines to fetch")
	c.Flags().BoolVar(&previous, "previous", false, "logs from the previous (terminated) container instance")
	c.Flags().BoolVarP(&follow, "follow", "f", false, "keep polling for new log lines until interrupted")
	return c
}

func podDeleteCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "delete <name>",
		Aliases: []string{"rm"},
		Short:   "Delete a pod (its controller will replace it)",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			if err := output.Confirm(fmt.Sprintf("delete pod %s in namespace %s", args[0], ns), yesFlag); err != nil {
				return err
			}
			path := "/pods/" + url.PathEscape(args[0]) + "?namespace=" + url.QueryEscape(ns)
			if err := cl.Send(cmd.Context(), http.MethodDelete, path, nil, nil); err != nil {
				return err
			}
			output.Successf("deleted pod %s", args[0])
			return nil
		},
	}
	addNamespaceFlag(c)
	return c
}

func podExecCmd() *cobra.Command {
	var container string
	c := &cobra.Command{
		Use:   "exec <name> -- <cmd...>",
		Short: "Run a one-shot command in a pod (like kubectl exec)",
		Args:  cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			podEnd := cmd.ArgsLenAtDash()
			if podEnd == -1 {
				podEnd = 1
			}
			if podEnd != 1 {
				return errors.New("usage: orchard pod exec <name> -- <cmd...>")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			body := map[string]any{"namespace": ns, "command": args[1:]}
			if container != "" {
				body["container"] = container
			}
			var res map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, "/pods/"+url.PathEscape(args[0])+"/exec", body, &res); err != nil {
				var apiErr *api.APIError
				if errors.As(err, &apiErr) && apiErr.Status == http.StatusForbidden {
					return fmt.Errorf("exec denied — this needs an API token with the 'exec' scope: %w", err)
				}
				return err
			}
			if fmtFlag() == output.FormatJSON {
				if err := output.JSON(res); err != nil {
					return err
				}
			} else {
				if out := str(res["stdout"]); out != "" {
					fmt.Print(out)
					if !strings.HasSuffix(out, "\n") {
						fmt.Println()
					}
				}
				if errOut := str(res["stderr"]); errOut != "" {
					fmt.Fprint(os.Stderr, errOut)
					if !strings.HasSuffix(errOut, "\n") {
						fmt.Fprintln(os.Stderr)
					}
				}
			}
			if ok, _ := res["success"].(bool); !ok {
				return fmt.Errorf("command failed in pod %s", args[0])
			}
			return nil
		},
	}
	addNamespaceFlag(c)
	c.Flags().StringVarP(&container, "container", "c", "", "container name (default: the pod's first container)")
	return c
}

func podShellCmd() *cobra.Command {
	var container string
	c := &cobra.Command{
		Use:   "shell <name>",
		Short: "Open an interactive shell in a pod",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !output.IsTTY() {
				return errors.New("pod shell needs an interactive terminal (stdout is not a TTY); use `orchard pod exec` for one-shot commands")
			}
			cl, cfg, err := client()
			if err != nil {
				return err
			}
			ns, err := podNamespace(cmd.Context(), cl, cfg, cmd.Flag("namespace").Value.String())
			if err != nil {
				return err
			}
			conn, err := cl.DialExec(cmd.Context(), args[0], ns, container)
			if err != nil {
				return fmt.Errorf("could not open shell (needs an API token with the 'exec' scope): %w", err)
			}
			return termsession.Run(cmd.Context(), conn, os.Stdin, os.Stdout)
		},
	}
	addNamespaceFlag(c)
	c.Flags().StringVarP(&container, "container", "c", "", "container name (default: the pod's first container)")
	return c
}
