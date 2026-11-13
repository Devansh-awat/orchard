package commands

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"gopkg.in/yaml.v3"
)

const (
	imageGCPath       = "/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/05-orchard-image-gc.conf"
	imageGCImageDir   = "/var/lib/rancher/k3s/agent/containerd"
	k3sConfigDir      = "/etc/rancher/k3s"
	imageGCMinAge     = time.Hour
	imageGCMaxAge     = 365 * 24 * time.Hour
	imageGCFirstMinor = 32
)

type imageGC struct {
	High   int
	Low    int
	MaxAge time.Duration
}

var (
	orchardImageGC = imageGC{High: 70, Low: 50, MaxAge: 72 * time.Hour}
	kubeletImageGC = imageGC{High: 85, Low: 80}
)

var imageGCKeys = []string{
	"image-gc-high-threshold",
	"image-gc-low-threshold",
	"imageGCHighThresholdPercent",
	"imageGCLowThresholdPercent",
	"imageMaximumGCAge",
}

func (g imageGC) validate() error {
	for _, p := range []struct {
		name  string
		value int
	}{{"--high", g.High}, {"--low", g.Low}} {
		if p.value < 1 || p.value > 99 {
			return fmt.Errorf("%s has to be a percentage from 1 to 99, not %d", p.name, p.value)
		}
	}
	if g.Low >= g.High {
		return fmt.Errorf("--low (%d%%) has to be below --high (%d%%): collection frees disk down to --low once usage reaches --high", g.Low, g.High)
	}
	if g.MaxAge != 0 && (g.MaxAge < imageGCMinAge || g.MaxAge > imageGCMaxAge) {
		return fmt.Errorf("--max-age has to be between 1h and 365d, or off, not %s", formatImageAge(g.MaxAge))
	}
	return nil
}

func (g imageGC) conf() string {
	return fmt.Sprintf(`apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
imageGCHighThresholdPercent: %d
imageGCLowThresholdPercent: %d
imageMaximumGCAge: %s
`, g.High, g.Low, formatImageAge(g.MaxAge))
}

func formatImageAge(d time.Duration) string {
	switch {
	case d == 0:
		return "0s"
	case d%time.Hour == 0:
		return fmt.Sprintf("%dh", d/time.Hour)
	case d%time.Minute == 0:
		return fmt.Sprintf("%dm", d/time.Minute)
	}
	return d.String()
}

func describeImageAge(d time.Duration) string {
	if d == 0 {
		return "never, only when the disk fills"
	}
	if d%(24*time.Hour) == 0 {
		days := d / (24 * time.Hour)
		if days == 1 {
			return "after 1 day unused"
		}
		return fmt.Sprintf("after %d days unused", days)
	}
	return "after " + formatImageAge(d) + " unused"
}

func parseImageAge(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	switch raw {
	case "off", "never", "0", "0s":
		return 0, nil
	case "":
		return 0, errors.New("--max-age needs a value, e.g. 72h, 3d or off")
	}
	if days, ok := strings.CutSuffix(raw, "d"); ok {
		n, err := strconv.ParseFloat(days, 64)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("--max-age %q isn't a duration: use e.g. 72h, 3d or off", raw)
		}
		return time.Duration(n * float64(24*time.Hour)), nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("--max-age %q isn't a duration: use e.g. 72h, 3d or off", raw)
	}
	return d, nil
}

func parseImageGCConf(raw []byte) (imageGC, error) {
	var doc struct {
		High   *int    `yaml:"imageGCHighThresholdPercent"`
		Low    *int    `yaml:"imageGCLowThresholdPercent"`
		MaxAge *string `yaml:"imageMaximumGCAge"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return imageGC{}, err
	}
	g := kubeletImageGC
	if doc.High != nil {
		g.High = *doc.High
	}
	if doc.Low != nil {
		g.Low = *doc.Low
	}
	if doc.MaxAge != nil {
		d, err := time.ParseDuration(strings.TrimSpace(*doc.MaxAge))
		if err != nil {
			return imageGC{}, fmt.Errorf("imageMaximumGCAge: %w", err)
		}
		g.MaxAge = d
	}
	return g, nil
}

type imageGCHost struct {
	path      string
	k3sConfig string
	unitPath  string
	imageDir  string
	managed   bool
	run       func(string, ...string) error
}

func liveImageGCHost(c *cli.Context) imageGCHost {
	return imageGCHost{
		path:      imageGCPath,
		k3sConfig: k3sConfigDir,
		unitPath:  k3sUnitPath,
		imageDir:  imageGCImageDir,
		managed:   k3sManaged(),
		run:       c.Run,
	}
}

func (h imageGCHost) read() (imageGC, bool, error) {
	raw, err := os.ReadFile(h.path)
	if errors.Is(err, fs.ErrNotExist) {
		return kubeletImageGC, false, nil
	}
	if err != nil {
		return imageGC{}, false, err
	}
	g, err := parseImageGCConf(raw)
	if err != nil {
		return imageGC{}, true, fmt.Errorf("couldn't parse %s: %w", h.path, err)
	}
	return g, true, nil
}

func (h imageGCHost) write(g imageGC) (bool, error) {
	if err := g.validate(); err != nil {
		return false, err
	}
	agentEtc := filepath.Dir(filepath.Dir(h.path))
	if _, err := os.Stat(agentEtc); err != nil {
		return false, fmt.Errorf("no k3s agent configuration in %s, so the kubelet wouldn't read this", agentEtc)
	}
	want := g.conf()
	if current, err := os.ReadFile(h.path); err == nil && string(current) == want {
		return false, nil
	}
	dir := filepath.Dir(h.path)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if err := os.Mkdir(dir, 0o700); err != nil {
			return false, err
		}
	}
	if err := os.WriteFile(h.path, []byte(want), 0o600); err != nil {
		return false, fmt.Errorf("couldn't write %s: %w", h.path, err)
	}
	return true, nil
}

func (h imageGCHost) restart(c *cli.Context) error {
	if !h.managed {
		c.Printf("no k3s service on this server to restart; the kubelet reads %s when it next starts\n", h.path)
		return nil
	}
	c.Printf("restarting k3s so the kubelet picks this up. Apps keep running, the API pauses.\n")
	if err := h.run("systemctl", "restart", k3sUnit); err != nil {
		return err
	}
	return h.run("kubectl", "wait", "--for=condition=Ready", "node", "--all", "--timeout=3m")
}

func (h imageGCHost) apply(c *cli.Context, g imageGC) error {
	changed, err := h.write(g)
	if err != nil {
		return err
	}
	printImageGC(c, g, true)
	if !changed {
		c.Printf("already set, k3s keeps running\n")
		return nil
	}
	return h.restart(c)
}

func (h imageGCHost) overrides() []string {
	var found []string
	files := []string{h.unitPath, filepath.Join(h.k3sConfig, "config.yaml")}
	dropins, _ := filepath.Glob(filepath.Join(h.k3sConfig, "config.yaml.d", "*.yaml"))
	more, _ := filepath.Glob(filepath.Join(h.k3sConfig, "config.yaml.d", "*.yml"))
	dropins = append(dropins, more...)
	sort.Strings(dropins)
	files = append(files, dropins...)
	ours := filepath.Base(h.path)
	_ = filepath.WalkDir(filepath.Dir(h.path), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || path == h.path {
			return nil
		}
		rel, _ := filepath.Rel(filepath.Dir(h.path), path)
		if filepath.Ext(path) == ".conf" && rel > ours {
			files = append(files, path)
		}
		return nil
	})
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, key := range imageGCKeys {
			if strings.Contains(string(raw), key) {
				found = append(found, file)
				break
			}
		}
	}
	return found
}

func printImageGC(c *cli.Context, g imageGC, written bool) {
	c.Printf("  collect at        %d%% disk used\n", g.High)
	c.Printf("  free down to      %d%% disk used\n", g.Low)
	c.Printf("  unused images go  %s\n", describeImageAge(g.MaxAge))
	switch {
	case g == orchardImageGC:
		c.Printf("these are Orchard's defaults\n")
	case g == kubeletImageGC && !written:
		c.Printf("these are the kubelet's defaults; orchardctl image-gc reset switches to Orchard's\n")
	default:
		c.Printf("Orchard's defaults are %d%%, %d%% and %s; orchardctl image-gc reset goes back to them\n",
			orchardImageGC.High, orchardImageGC.Low, formatImageAge(orchardImageGC.MaxAge))
	}
}

type diskStats struct {
	used, free uint64
	percent    int
}

func statDisk(path string) (diskStats, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil || st.Blocks == 0 {
		return diskStats{}, false
	}
	capacity := uint64(st.Blocks) * uint64(st.Bsize)
	free := uint64(st.Bavail) * uint64(st.Bsize)
	return diskStats{
		used:    capacity - uint64(st.Bfree)*uint64(st.Bsize),
		free:    free,
		percent: 100 - int(free*100/capacity),
	}, true
}

func humanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

func (h imageGCHost) status(c *cli.Context) error {
	g, written, err := h.read()
	if err != nil {
		return err
	}
	if written {
		c.Printf("image garbage collection, from %s:\n", h.path)
	} else {
		c.Printf("image garbage collection (no %s, so the kubelet's defaults):\n", h.path)
	}
	printImageGC(c, g, written)
	if disk, ok := statDisk(h.imageDir); ok {
		c.Printf("the disk images live on is %d%% used, %s free\n", disk.percent, humanBytes(disk.free))
	}
	for _, file := range h.overrides() {
		c.Warnf("note: %s also sets image garbage collection, and wins over %s\n", file, filepath.Base(h.path))
	}
	if h.managed {
		if v, err := installedK3s(c); err == nil && v.major == 1 && v.minor < imageGCFirstMinor {
			c.Warnf("note: k3s %s doesn't read kubelet drop-ins, so this has no effect until k3s 1.%d. Run: sudo orchardctl k3s upgrade\n", v.raw, imageGCFirstMinor)
		}
	}
	return nil
}

func (h imageGCHost) prune(c *cli.Context) error {
	if !h.managed {
		return errors.New("no k3s service on this server")
	}
	before, beforeOK := statDisk(h.imageDir)
	c.Printf("removing every image no container is using\n")
	if err := h.run(k3sBinary, "crictl", "rmi", "--prune"); err != nil {
		return err
	}
	after, afterOK := statDisk(h.imageDir)
	if beforeOK && afterOK {
		freed := uint64(0)
		if before.used > after.used {
			freed = before.used - after.used
		}
		c.Printf("freed %s, the disk is now %d%% used\n", humanBytes(freed), after.percent)
	}
	return nil
}

func parseImageGCFlags(args []string, base imageGC) (imageGC, error) {
	g := base
	seen := false
	for i := 0; i < len(args); i++ {
		name, value, inline := strings.Cut(args[i], "=")
		switch name {
		case "--high", "--low", "--max-age":
		default:
			return imageGC{}, fmt.Errorf("unknown argument %q: use --high, --low or --max-age", args[i])
		}
		if !inline {
			if i+1 >= len(args) {
				return imageGC{}, fmt.Errorf("%s needs a value", name)
			}
			i++
			value = args[i]
		}
		seen = true
		switch name {
		case "--high", "--low":
			n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(value), "%"))
			if err != nil {
				return imageGC{}, fmt.Errorf("%s %q isn't a whole percentage", name, value)
			}
			if name == "--high" {
				g.High = n
			} else {
				g.Low = n
			}
		case "--max-age":
			d, err := parseImageAge(value)
			if err != nil {
				return imageGC{}, err
			}
			g.MaxAge = d
		}
	}
	if !seen {
		return imageGC{}, errors.New("nothing to set: pass --high, --low or --max-age")
	}
	return g, g.validate()
}

func (h imageGCHost) ensureDefaults(c *cli.Context) {
	if !h.managed {
		return
	}
	if _, err := os.Stat(h.path); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return
	}
	changed, err := h.write(orchardImageGC)
	if err != nil {
		c.Warnf("note: image garbage collection wasn't set up: %s\n", err)
		return
	}
	if !changed {
		return
	}
	c.Printf("unused images now go at %d%% disk or %s; orchardctl image-gc --help to change it\n",
		orchardImageGC.High, describeImageAge(orchardImageGC.MaxAge))
	if err := h.restart(c); err != nil {
		c.Warnf("note: k3s didn't restart cleanly after setting up image garbage collection: %s\n", err)
	}
}

func (h imageGCHost) command(c *cli.Context, args []string) error {
	action := "status"
	if len(args) > 0 {
		action, args = args[0], args[1:]
	}
	switch action {
	case "status":
		return h.status(c)
	case "set":
		base, written, err := h.read()
		if err != nil {
			return err
		}
		if !written {
			base = orchardImageGC
		}
		g, err := parseImageGCFlags(args, base)
		if err != nil {
			return err
		}
		return h.apply(c, g)
	case "reset":
		if len(args) > 0 {
			return fmt.Errorf("reset takes no arguments")
		}
		return h.apply(c, orchardImageGC)
	case "prune":
		if len(args) > 0 {
			return fmt.Errorf("prune takes no arguments")
		}
		return h.prune(c)
	}
	return fmt.Errorf("unknown action %q: use status, set, reset or prune", action)
}

func ImageGC() *cli.Command {
	return &cli.Command{
		Name:    "image-gc",
		Args:    "[status|set|reset|prune]",
		Summary: "when unused container images are removed to free disk",
		Root:    true,
		Usage: `orchardctl image-gc - when unused container images are removed

Every deploy pulls a new image onto this server, and the old ones stay until
the kubelet collects them. Out of the box it waits until the disk is 85% full,
then frees down to 80%, which on a small server leaves little headroom. Orchard
starts collecting at 70%, frees down to 50%, and removes any image that no
container has used for 72 hours. Images are pulled again from the registry if
they are needed later.

  orchardctl image-gc                  show the settings and how full the disk is
  orchardctl image-gc set [flags]      change them
  orchardctl image-gc reset            go back to Orchard's defaults
  orchardctl image-gc prune            remove every unused image now

  --high <percent>    disk usage that starts a collection (1-99)
  --low <percent>     disk usage a collection frees down to, below --high
  --max-age <age>     remove images unused this long, e.g. 72h or 3d, from 1h
                      to 365d, or off to only collect when the disk fills

Flags you leave out keep their current value. For example:

  sudo orchardctl image-gc set --high 80 --low 60
  sudo orchardctl image-gc set --max-age 7d

set and reset write ` + imageGCPath + `,
a kubelet configuration drop-in, and restart k3s when it changed. Apps keep
running while the API pauses. kubelet-arg flags in /etc/rancher/k3s/config.yaml
and drop-ins that sort after this one win over it; status lists any it finds.
New installs and orchardctl update write Orchard's defaults when the file is
missing, and never change it once it's there.

The kubelet counts an image's unused time from when it last started, so a
restart puts every image's clock back to zero.

prune runs k3s crictl rmi --prune, which removes every image no running
container uses, including those of stopped apps and of jobs that run now and
then, such as builds and database backups. They are pulled again when needed.
`,
		Run: func(c *cli.Context, args []string) error {
			return liveImageGCHost(c).command(c, args)
		},
	}
}
