package commands

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	updateTimerUnit   = "orchard-update.timer"
	updateServiceUnit = "orchard-update.service"
)

type hostLayout struct {
	StateDir     string
	Bin          string
	SystemBin    string
	SystemdDir   string
	K3sUninstall string
	Rancher      []string
	Runtime      []string
	Homes        []string
}

func Uninstall() *cli.Command {
	return &cli.Command{
		Name:    "uninstall",
		Summary: "remove Orchard, k3s and everything on them from this machine",
		Root:    true,
		Usage: `orchardctl uninstall - remove Orchard from this machine

Deletes this instance for good: k3s with every app, database and volume on it,
then what k3s-uninstall.sh leaves behind: the values file holding your secrets,
the nightly update timer, orchardctl and its orchard-* links, helm, yq,
/etc/rancher, and root's kubectl and helm state. There is no undo.

It asks you to type a phrase naming the instance, and takes no flag to skip
that. Piping the phrase in works for a script that knows what it is deleting.

If k3s or helm were on this machine before Orchard was, they go too, along with
anything else running on that k3s and any other clusters in root's ~/.kube.

Backups stored off this machine, DNS records and rules the installer opened in
ufw or firewalld are left alone.
`,
		Run: func(c *cli.Context, args []string) error {
			if len(args) > 0 {
				return fmt.Errorf("orchardctl uninstall takes no arguments")
			}
			return runUninstall(c, layoutFor(c.Env), c.Run)
		},
	}
}

func layoutFor(env cli.Env) hostLayout {
	var homes []string
	if current, err := user.Current(); err == nil {
		homes = append(homes, current.HomeDir)
	}
	if home := os.Getenv("HOME"); home != "" && (len(homes) == 0 || homes[0] != home) {
		homes = append(homes, home)
	}
	return hostLayout{
		StateDir:     env.StateDir,
		Bin:          env.Bin,
		SystemBin:    "/usr/local/bin",
		SystemdDir:   "/etc/systemd/system",
		K3sUninstall: "/usr/local/bin/k3s-uninstall.sh",
		Rancher:      []string{"/etc/rancher", "/var/lib/rancher"},
		Runtime:      []string{"/var/lib/vector-orchard", "/etc/cni"},
		Homes:        homes,
	}
}

func uninstallPhrase(valuesPath string) string {
	if values, err := cli.LoadValues(valuesPath); err == nil {
		if host, _ := values.Get("ingress.host").(string); host != "" {
			return "delete " + host
		}
	}
	if name, err := os.Hostname(); err == nil && name != "" {
		return "delete " + name
	}
	return "delete orchard"
}

func uninstallWarning(h hostLayout) string {
	var b strings.Builder
	b.WriteString("This permanently deletes Orchard from this machine:\n\n")
	b.WriteString("  k3s, and every app, database and volume on it\n")
	fmt.Fprintf(&b, "  %s, including the values file with your secrets\n", h.StateDir)
	fmt.Fprintf(&b, "  %s and %s\n", updateTimerUnit, updateServiceUnit)
	fmt.Fprintf(&b, "  orchardctl, its orchard-* links and orchard-sync-commands in %s\n", h.Bin)
	fmt.Fprintf(&b, "  helm and yq in %s\n", h.SystemBin)
	for _, path := range append(append([]string{}, h.Rancher...), h.Runtime...) {
		fmt.Fprintf(&b, "  %s\n", path)
	}
	for _, home := range h.Homes {
		fmt.Fprintf(&b, "  %s and helm's state under %s\n", filepath.Join(home, ".kube"), home)
	}
	b.WriteString("\nThere is no undo. Backups stored off this machine are left alone.\n")
	return b.String()
}

func runUninstall(c *cli.Context, h hostLayout, run func(string, ...string) error) error {
	if !confirmTyped(c, uninstallWarning(h), uninstallPhrase(c.Env.Values)) {
		return fmt.Errorf("that did not match, so nothing was changed")
	}

	removeUpdateTimer(c, h, run)

	if pathExists(h.K3sUninstall) {
		if err := run(h.K3sUninstall); err != nil {
			return fmt.Errorf("k3s did not uninstall cleanly, so the rest is still here. Run this again: %w", err)
		}
	} else {
		c.Printf("no %s here, so k3s is already gone\n", h.K3sUninstall)
	}

	failed := 0
	for _, path := range h.leftovers() {
		if !removeLeftover(c, path) {
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d paths could not be removed, see above", failed)
	}

	c.Printf("Orchard is gone from this machine.\n")
	c.Printf("Any rules the installer opened in ufw or firewalld are still there.\n")
	return nil
}

func removeUpdateTimer(c *cli.Context, h hostLayout, run func(string, ...string) error) {
	timer := filepath.Join(h.SystemdDir, updateTimerUnit)
	service := filepath.Join(h.SystemdDir, updateServiceUnit)
	if !pathExists(timer) && !pathExists(service) {
		return
	}

	if pathExists(timer) {
		if err := run("systemctl", "disable", "--now", updateTimerUnit); err != nil {
			c.Warnf("could not disable %s: %v\n", updateTimerUnit, err)
		}
	}
	if pathExists(service) {
		if err := run("systemctl", "stop", updateServiceUnit); err != nil {
			c.Warnf("could not stop %s: %v\n", updateServiceUnit, err)
		}
	}

	removeLeftover(c, timer)
	removeLeftover(c, service)
	removeLeftover(c, filepath.Join(h.SystemdDir, "timers.target.wants", updateTimerUnit))

	if err := run("systemctl", "daemon-reload"); err != nil {
		c.Warnf("could not reload systemd: %v\n", err)
	}
}

func (h hostLayout) leftovers() []string {
	paths := []string{h.StateDir}
	paths = append(paths, h.Rancher...)
	paths = append(paths, h.Runtime...)
	for _, home := range h.Homes {
		paths = append(paths,
			filepath.Join(home, ".kube"),
			filepath.Join(home, ".config", "helm"),
			filepath.Join(home, ".cache", "helm"),
			filepath.Join(home, ".local", "share", "helm"),
		)
	}
	paths = append(paths,
		filepath.Join(h.SystemBin, "helm"),
		filepath.Join(h.SystemBin, "yq"),
		filepath.Join(h.Bin, "orchard-sync-commands"),
	)
	paths = append(paths, orchardLinks(h.Bin)...)
	return append(paths, filepath.Join(h.Bin, "orchardctl.new"), filepath.Join(h.Bin, "orchardctl"))
}

func orchardLinks(bin string) []string {
	seen := map[string]bool{}
	var links []string
	add := func(path string) {
		if !seen[path] {
			seen[path] = true
			links = append(links, path)
		}
	}
	for _, alias := range Aliases {
		add(filepath.Join(bin, alias))
	}
	entries, err := os.ReadDir(bin)
	if err != nil {
		return links
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "orchard-") || entry.Type()&os.ModeSymlink == 0 {
			continue
		}
		path := filepath.Join(bin, entry.Name())
		if target, err := os.Readlink(path); err == nil && filepath.Base(target) == "orchardctl" {
			add(path)
		}
	}
	return links
}

func removeLeftover(c *cli.Context, path string) bool {
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) || strings.Count(clean, string(filepath.Separator)) < 2 {
		c.Warnf("refusing to remove %q\n", path)
		return false
	}
	if !pathExists(clean) {
		return true
	}
	if err := os.RemoveAll(clean); err != nil {
		c.Warnf("could not remove %s: %v\n", clean, err)
		return false
	}
	c.Printf("removed %s\n", clean)
	return true
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
