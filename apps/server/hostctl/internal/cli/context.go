package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Env is everything a command needs to know about the host it is running on.
//
// Defaults that work unrendered, so the binary can be copied straight out of
// the server image and run. install.sh writes the env file when paths differ.
type Env struct {
	StateDir   string
	Values     string
	Chart      string
	Namespace  string
	Bin        string
	Kubeconfig string
}

func LoadEnv() Env {
	e := Env{
		StateDir:   envOr("ORCHARD_STATE_DIR", "/etc/orchard"),
		Chart:      "oci://ghcr.io/hackclub/orchard/charts/orchard",
		Namespace:  "orchard",
		Bin:        "/usr/local/bin",
		Kubeconfig: envOr("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml"),
	}

	// The env file is shell, and it is written by install.sh rather than by a
	// user, so a line-oriented read is enough. Anything unparseable is skipped
	// rather than fatal: a malformed file should not make the host
	// unmanageable.
	for k, v := range readShellEnv(filepath.Join(e.StateDir, "env")) {
		switch k {
		case "ORCHARD_STATE_DIR":
			e.StateDir = v
		case "ORCHARD_VALUES":
			e.Values = v
		case "ORCHARD_CHART":
			e.Chart = v
		case "ORCHARD_NAMESPACE":
			e.Namespace = v
		case "ORCHARD_BIN":
			e.Bin = v
		case "KUBECONFIG":
			e.Kubeconfig = v
		}
	}

	// Explicit environment still wins over the file, so a one-off override on
	// the command line behaves the way an operator expects.
	e.StateDir = envOr("ORCHARD_STATE_DIR", e.StateDir)
	e.Chart = envOr("ORCHARD_CHART", e.Chart)
	e.Namespace = envOr("ORCHARD_NAMESPACE", e.Namespace)
	e.Bin = envOr("ORCHARD_BIN", e.Bin)
	e.Kubeconfig = envOr("KUBECONFIG", e.Kubeconfig)
	if e.Values == "" {
		e.Values = filepath.Join(e.StateDir, "values.yaml")
	}
	e.Values = envOr("ORCHARD_VALUES", e.Values)
	return e
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func readShellEnv(path string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		out[strings.TrimSpace(key)] = value
	}
	return out
}

// Context is handed to every command: resolved paths plus the few ways a
// command is allowed to reach the outside world.
type Context struct {
	Env    Env
	Stdout *os.File
	Stderr *os.File
}

func (c *Context) command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "KUBECONFIG="+c.Env.Kubeconfig)
	return cmd
}

// Run streams a child process straight through, so helm and kubectl keep their
// progress output and exit codes.
func (c *Context) Run(name string, args ...string) error {
	cmd := c.command(name, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = c.Stdout
	cmd.Stderr = c.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// RunWithInput is Run with the child's stdin fed from a string rather than the
// terminal, for secrets that must not pass through an argument list.
func (c *Context) RunWithInput(input string, name string, args ...string) error {
	cmd := c.command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	cmd.Stdout = c.Stdout
	cmd.Stderr = c.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// Capture returns a child process's stdout, with stderr discarded.
func (c *Context) Capture(name string, args ...string) (string, error) {
	out, err := c.command(name, args...).Output()
	return string(out), err
}

// CaptureWithInput returns stdout with stdin fed from a string, for secrets that
// must not pass through an argument list.
func (c *Context) CaptureWithInput(input string, name string, args ...string) (string, error) {
	cmd := c.command(name, args...)
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.Output()
	return string(out), err
}

func (c *Context) Kubectl(args ...string) error {
	return c.Run("kubectl", append([]string{"-n", c.Env.Namespace}, args...)...)
}

func (c *Context) KubectlOut(args ...string) (string, error) {
	return c.Capture("kubectl", append([]string{"-n", c.Env.Namespace}, args...)...)
}

func (c *Context) Printf(format string, a ...any) {
	fmt.Fprintf(c.Stdout, format, a...)
}

func (c *Context) Warnf(format string, a ...any) {
	fmt.Fprintf(c.Stderr, format, a...)
}
