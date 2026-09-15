package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/buildctx"
	"github.com/hackclub/orchard/cli/internal/config"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/spf13/cobra"
)

var exposeRe = regexp.MustCompile(`(?im)^\s*EXPOSE\s+(\d+)`)

func upCmd() *cobra.Command {
	var name, dockerfile string
	var rootDir, installCmd, buildCmd, startCmd, outputDir string
	var port int
	var railpack, detach bool
	c := &cobra.Command{
		Use:     "up [dir]",
		GroupID: groupCore,
		Short:   "Deploy the current directory",
		Long: "Packs the directory (honoring .dockerignore, else .gitignore), uploads it,\n" +
			"and builds/deploys it on the platform. First run creates the deployment (with\n" +
			"a protected URL) in the linked project; later runs just ship the new code.\n" +
			"With a Dockerfile present it builds that; otherwise Railpack detects the\n" +
			"language automatically. Requires the server to have local deploys enabled.",
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
				return errors.New("could not derive a deployment name; pass --name")
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
					return err
				}
				deploymentID = str(created["id"])
				output.Successf("created deployment %s (%s build)", name, buildType)
				if u := str(created["url"]); u != "" {
					output.Successf("will be live at %s (visible to your org until made public)", u)
				} else if target := firstIngressURL(created); target != "" {
					output.Successf("will be live at %s (visible to your org until made public)", target)
				}
			}

			sp := output.NewSpinner("packing build context")
			data, files, perr := buildctx.Pack(abs)
			if perr != nil {
				sp.Stop()
				return perr
			}
			sp.Update(fmt.Sprintf("uploading %.1fMB (%d files)", float64(len(data))/1024/1024, files))
			_, uerr := cl.Upload(cmd.Context(), "/deployments/"+url.PathEscape(deploymentID)+"/build-context", "context", "context.tar.gz", bytes.NewReader(data))
			sp.Stop()
			if uerr != nil {
				return uerr
			}
			output.Successf("uploaded %.1fMB (%d files), build started", float64(len(data))/1024/1024, files)

			if detach {
				output.Warnf("follow the build with: orchard deploy logs %s --build -f", deploymentID)
				return nil
			}

			if err := followBuildLogsSSE(cmd.Context(), cl, deploymentID); err != nil {
				if errors.Is(err, errSSEUnsupported) {
					return runWait(cmd.Context(), cl, deployWaitBuild(deploymentID), 10*time.Minute)
				}
				return err
			}
			printDeploySuccess(cmd.Context(), cl, cfg.APIURL, deploymentID)
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "deployment name (default: directory name)")
	c.Flags().StringVar(&dockerfile, "dockerfile", "", "Dockerfile path relative to the directory")
	c.Flags().BoolVar(&railpack, "railpack", false, "force a Railpack build even when a Dockerfile exists")
	c.Flags().IntVar(&port, "port", 0, "port the app listens on (default: EXPOSE or 3000)")
	c.Flags().BoolVar(&detach, "detach", false, "start the build without following its logs")
	c.Flags().StringVar(&rootDir, "root", "", "directory of the app inside the repo (monorepos)")
	c.Flags().StringVar(&installCmd, "install-cmd", "", "override the detected install command")
	c.Flags().StringVar(&buildCmd, "build-cmd", "", "override the detected build command")
	c.Flags().StringVar(&startCmd, "start-cmd", "", "override the detected start command")
	c.Flags().StringVar(&outputDir, "output-dir", "", "directory of built static files; serves the app as a static site")
	return c
}

func slugify(v string) string {
	v = strings.ToLower(v)
	v = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(v, "-")
	return strings.Trim(v, "-")
}
