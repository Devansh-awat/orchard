package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/buildctx"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var exposeRe = regexp.MustCompile(`(?im)^\s*EXPOSE\s+(\d+)`)

var fromRe = regexp.MustCompile(`(?im)^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?`)

func finalBaseImage(dockerfile string) string {
	stages := map[string]string{}
	last := ""
	for _, m := range fromRe.FindAllStringSubmatch(dockerfile, -1) {
		base := m[1]
		if parent, ok := stages[strings.ToLower(base)]; ok {
			base = parent
		}
		if m[2] != "" {
			stages[strings.ToLower(m[2])] = base
		}
		last = base
	}
	if strings.Contains(last, "$") || strings.EqualFold(last, "scratch") {
		return ""
	}
	return last
}

func upCmd() *cobra.Command {
	var name, dockerfile string
	var rootDir, installCmd, buildCmd, startCmd, outputDir string
	var port int
	var railpack, detach, wait bool
	var timeout time.Duration
	c := &cobra.Command{
		Use:     "up [dir]",
		GroupID: groupCore,
		Short:   "Deploy the current directory",
		Long: "Packs the directory (honoring .dockerignore, else .gitignore), uploads it,\n" +
			"and builds and deploys it. The first run creates the deployment (with a\n" + "protected URL) in the linked project. Later runs deploy the new code.\n" +
			"With a Dockerfile present it builds that; otherwise Railpack detects the\n" +
			"language automatically. Requires the server to have local deploys enabled.\n\n" +
			"It blocks until the deploy is live and exits 9 if the build fails or 10 if\n" +
			"the pods crash. --wait=false returns when the build finishes. In\n" +
			"JSON mode build logs stream to stderr and stdout carries one result object:\n" +
			"{deploymentId, releaseId, phase, url, ...}.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) == 1 {
				dir = args[0]
			}
			abs, err := filepath.Abs(dir)
			if err != nil {
				return err
			}

			// orchard.json supplies defaults; an explicit flag always wins.
			buildCfg, _, _ := config.FindBuildConfig(abs)
			if buildCfg != nil {
				if !cmd.Flags().Changed("root") {
					rootDir = buildCfg.RootDirectory
				}
				if !cmd.Flags().Changed("install-cmd") {
					installCmd = buildCfg.InstallCommand
				}
				if !cmd.Flags().Changed("build-cmd") {
					buildCmd = buildCfg.BuildCommand
				}
				if !cmd.Flags().Changed("start-cmd") {
					startCmd = buildCfg.StartCommand
				}
				if !cmd.Flags().Changed("output-dir") {
					outputDir = buildCfg.OutputDirectory
				}
				if !cmd.Flags().Changed("dockerfile") {
					dockerfile = buildCfg.Dockerfile
				}
				if !cmd.Flags().Changed("port") && buildCfg.Port > 0 {
					port = buildCfg.Port
				}
			}

			cl, cfg, err := client()
			if err != nil {
				return err
			}
			projectID, err := requireProject(cmd.Context(), cl, cfg)
			if err != nil {
				return err
			}

			if name == "" {
				name = slugify(filepath.Base(abs))
			}
			if name == "" {
				return errors.New("couldn't derive a deployment name; pass --name")
			}

			buildType := "railpack"
			dockerfilePath := ""
			if !railpack {
				candidate := dockerfile
				if candidate == "" {
					if _, serr := os.Stat(filepath.Join(abs, "Dockerfile")); serr == nil {
						candidate = "Dockerfile"
					}
				}
				if candidate != "" {
					buildType = "dockerfile"
					dockerfilePath = candidate
				}
			}

			resolvedPort := port
			if resolvedPort == 0 && dockerfilePath != "" {
				if content, rerr := os.ReadFile(filepath.Join(abs, dockerfilePath)); rerr == nil {
					if m := exposeRe.FindSubmatch(content); m != nil {
						fmt.Sscanf(string(m[1]), "%d", &resolvedPort)
					} else if base := finalBaseImage(string(content)); base != "" {
						resolvedPort = detectImagePort(cmd.Context(), cl, projectID, base)
					}
				}
			}
			if resolvedPort == 0 {
				resolvedPort = 3000
			}

			var listRaw any
			if err := cl.GetJSON(cmd.Context(), "/projects/"+url.PathEscape(projectID)+"/deployments", &listRaw); err != nil {
				return err
			}
			deploymentID := ""
			for _, d := range asList(listRaw) {
				if str(d["name"]) != name {
					continue
				}
				if str(d["githubRepo"]) != "" {
					return fmt.Errorf("deployment %q builds from GitHub; pick another name with --name", name)
				}
				deploymentID = str(d["id"])
				break
			}

			if deploymentID == "" {
				body := map[string]any{
					"name":      name,
					"buildType": buildType,
					"port":      resolvedPort,
					"autoUrl":   true,
				}
				if dockerfilePath != "" {
					body["dockerfilePath"] = dockerfilePath
				}
				if buildType == "railpack" {
					body["env"] = []map[string]any{{"key": "PORT", "value": fmt.Sprintf("%d", resolvedPort)}}
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
				}
				var created map[string]any
				if err := cl.Send(cmd.Context(), http.MethodPost, "/projects/"+url.PathEscape(projectID)+"/deployments/from-local", body, &created); err != nil {
					return localDeploysHint(err)
				}
				deploymentID = str(created["id"])
				output.Successf("created deployment %s (%s build)", name, buildType)
				if u := str(created["url"]); u != "" {
					output.Successf("will be live at %s (visible to your organization until made public)", u)
				} else if target := firstIngressURL(created); target != "" {
					output.Successf("will be live at %s (visible to your organization until made public)", target)
				}
			}

			if !cmd.Flags().Changed("wait") {
				wait = !output.IsTTY()
			}
			jsonMode := fmtFlag() == output.FormatJSON
			var logW io.Writer = os.Stdout
			if jsonMode {
				logW = os.Stderr
			}

			sp := output.NewSpinner("packing build context")
			data, files, perr := buildctx.Pack(abs)
			if perr != nil {
				sp.Stop()
				return perr
			}
			sp.Update(fmt.Sprintf("uploading %.1fMB (%d files)", float64(len(data))/1024/1024, files))
			uploaded, uerr := cl.Upload(cmd.Context(), "/deployments/"+url.PathEscape(deploymentID)+"/build-context", "context", "context.tar.gz", bytes.NewReader(data))
			sp.Stop()
			if uerr != nil {
				return localDeploysHint(uerr)
			}
			output.Successf("uploaded %.1fMB (%d files), build started", float64(len(data))/1024/1024, files)
			var uploadRaw map[string]any
			_ = json.Unmarshal(uploaded, &uploadRaw)
			pin := api.PinFrom(uploadRaw)

			if detach {
				output.Warnf("follow the build with: orchard logs %s --build -f", deploymentID)
				if jsonMode {
					return output.JSON(map[string]any{"deploymentId": deploymentID, "releaseId": nil, "phase": "building", "url": nil})
				}
				return nil
			}

			started := time.Now()
			var followLimit time.Duration
			if wait || cmd.Flags().Changed("timeout") {
				followLimit = timeout
			}
			ferr := followBuildLogsSSE(cmd.Context(), cl, deploymentID, logW, buildFollow{Timeout: followLimit, Pin: pin})
			sseMissing := errors.Is(ferr, errSSEUnsupported)
			if sseMissing {
				ferr = nil
			}
			if ferr != nil {
				if errors.Is(ferr, api.ErrDeployFailed) || errors.Is(ferr, api.ErrWaitTimeout) {
					if r, gerr := cl.GetRollout(cmd.Context(), deploymentID, pin, 0); gerr == nil {
						if errors.Is(ferr, api.ErrDeployFailed) && r.Build.Error != "" {
							output.Errorf("build failed")
							output.Fprintln(os.Stderr, indent(r.Build.Error))
						}
						if jsonMode {
							_ = output.JSON(rolloutJSON(deploymentID, r))
						}
					}
				}
				return ferr
			}
			if !wait {
				if sseMissing {
					return runWait(cmd.Context(), cl, deployWaitBuild(deploymentID), timeout)
				}
				if cmd.Flags().Changed("wait") {
					printDeploySuccess(cmd.Context(), cl, cfg.APIURL, deploymentID)
					return nil
				}
				started = time.Now()
			}
			remaining := timeout - time.Since(started)
			if remaining < time.Second {
				remaining = time.Second
			}
			r, werr := waitRollout(cmd.Context(), cl, deploymentID, pin, remaining, deployWaitBuild(deploymentID))
			if jsonMode && r != nil {
				if err := output.JSON(rolloutJSON(deploymentID, r)); err != nil && werr == nil {
					werr = err
				}
			}
			if werr != nil {
				return werr
			}
			printDeployFollowUp(cmd.Context(), cl, cfg.APIURL, deploymentID, r)
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "deployment name (default: directory name)")
	c.Flags().StringVar(&dockerfile, "dockerfile", "", "Dockerfile path relative to the directory")
	c.Flags().BoolVar(&railpack, "railpack", false, "force a Railpack build even when a Dockerfile exists")
	c.Flags().IntVar(&port, "port", 0, "port the app listens on (default: EXPOSE, the base image's port, or 3000)")
	c.Flags().BoolVar(&detach, "detach", false, "start the build without following its logs")
	c.Flags().BoolVar(&wait, "wait", false, "block until the deploy is live; --wait=false returns when the build finishes")
	c.Flags().DurationVar(&timeout, "timeout", 10*time.Minute, "give up waiting after this long (exit 8)")
	c.Flags().StringVar(&rootDir, "root", "", "directory of the app inside the repo (monorepos)")
	c.Flags().StringVar(&installCmd, "install-cmd", "", "override the detected install command")
	c.Flags().StringVar(&buildCmd, "build-cmd", "", "override the detected build command")
	c.Flags().StringVar(&startCmd, "start-cmd", "", "override the detected start command")
	c.Flags().StringVar(&outputDir, "output-dir", "", "directory of built static files; serves the app as a static site")
	return c
}

func localDeploysHint(err error) error {
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) {
		return err
	}
	if strings.Contains(apiErr.Message, "Local deploys need S3") {
		return fmt.Errorf("%w\nOr deploy from a repository: orchard import owner/repo", err)
	}
	if !strings.Contains(apiErr.Message, "Local deploys are disabled") {
		return err
	}
	return fmt.Errorf("%w\norchard up is off on this server. An instance admin can turn it on: https://docs.orchard.my/deploy/deploy-from-terminal/#turn-on-local-deploys\nOr deploy from a repository: orchard import owner/repo", err)
}

func slugify(v string) string {
	v = strings.ToLower(v)
	v = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(v, "-")
	return strings.Trim(v, "-")
}
