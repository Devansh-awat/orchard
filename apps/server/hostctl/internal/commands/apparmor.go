package commands

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	apparmorStackingProc = "/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined"
	apparmorDir          = "/etc/apparmor.d"
	containerdProfile    = "cri-containerd.apparmor.d"
)

const containerdProfileText = `abi <abi/3.0>,
#include <tunables/global>

profile cri-containerd.apparmor.d flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=cri-containerd.apparmor.d,
  signal (send,receive) peer=cri-containerd.apparmor.d//&unconfined,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  deny mount,

  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d,
  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d//&unconfined,
}
`

func allowContainerSignals(c *cli.Context, procPath, dir string, run func(string, ...string) error) {
	current, err := os.ReadFile(procPath)
	if err != nil || strings.TrimSpace(string(current)) != "1" {
		return
	}
	for _, sub := range []string{"abi", "abstractions"} {
		if info, err := os.Stat(filepath.Join(dir, sub)); err != nil || !info.IsDir() {
			return
		}
	}
	file := filepath.Join(dir, containerdProfile)
	if err := os.WriteFile(file, []byte(containerdProfileText), 0o644); err != nil {
		c.Warnf("couldn't write %s: %v; databases can't checkpoint until it exists\n", file, err)
		return
	}
	if err := run("apparmor_parser", "-r", "-W", file); err != nil {
		c.Warnf("couldn't load %s: %v; databases can't checkpoint until it loads\n", file, err)
		return
	}
	c.Printf("let processes in a container signal each other under this kernel's AppArmor stacking\n")
}
