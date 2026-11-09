package commands

import (
	"os"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	usernsSysctl     = "kernel.apparmor_restrict_unprivileged_userns"
	usernsProcPath   = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
	usernsSysctlConf = "/etc/sysctl.d/90-orchard-builds.conf"
)

func allowRootlessBuilds(c *cli.Context, procPath, confPath string, run func(string, ...string) error) {
	current, err := os.ReadFile(procPath)
	if err != nil || strings.TrimSpace(string(current)) != "1" {
		return
	}
	if values, err := cli.LoadValues(c.Env.Values); err == nil {
		if values.Get("builderSandbox.enabled") == true || values.Get("builders.allowPrivilegedOnHost") == true {
			return
		}
	}
	if err := os.WriteFile(confPath, []byte(usernsSysctl+" = 0\n"), 0o644); err != nil {
		c.Warnf("couldn't write %s: %v; builds fail until %s is 0\n", confPath, err, usernsSysctl)
		return
	}
	if err := run("sysctl", "-q", "-w", usernsSysctl+"=0"); err != nil {
		c.Warnf("couldn't set %s to 0: %v; builds fail until it is\n", usernsSysctl, err)
		return
	}
	c.Printf("allowed user namespaces so builds can run rootless\n")
}
