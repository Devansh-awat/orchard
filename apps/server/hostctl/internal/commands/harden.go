package commands

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	registryUser        = "orchard"
	registryDefaultPort = 5000
	registryClusterHost = "zot.orchard.svc.cluster.local:5000"
	registriesYamlPath  = "/etc/rancher/k3s/registries.yaml"
	k3sUnitPath         = "/etc/systemd/system/k3s.service"
	podCIDR             = "10.42.0.0/16"
	serviceCIDR         = "10.43.0.0/16"
	tailscaleCIDR       = "100.64.0.0/10"
)

func Harden() *cli.Command {
	return &cli.Command{
		Name:    "harden",
		Summary: "close the registry to the outside and open the firewall for k3s",
		Root:    true,
		Usage: `orchardctl harden - what a fresh install does, applied to an existing one

Earlier installers published the image registry as a NodePort with no
authentication, so on a server with a public address, anyone could pull every image built here
or push over a tag and deploy it on the next rollout. This moves the registry
onto loopback, adds a password, and sets that password on the containerd mirror
the kubelet pulls through and on the credentials the builders push with.

It also opens an active ufw or firewalld for k3s. Without this, every pod times
out against the API after a reboot. It also makes the k3s kubeconfig readable
by root only.

orchardctl update runs this first, so an upgrade fixes an old install. Run it by
hand on a server you don't want to upgrade yet. You can run it more than once.

  ORCHARD_REGISTRY_PORT   loopback port for the registry mirror (default 5000)
`,
		Run: func(c *cli.Context, args []string) error {
			return harden(c)
		},
	}
}

func harden(c *cli.Context) error {
	if err := lockdownRegistry(c); err != nil {
		return err
	}
	if err := ensureFirewall(c); err != nil {
		return err
	}
	return privateKubeconfig(c)
}

func privateKubeconfig(c *cli.Context) error {
	info, err := os.Stat(c.Env.Kubeconfig)
	if err != nil {
		return nil
	}
	if info.Mode().Perm() == 0o600 {
		return nil
	}
	if err := os.Chmod(c.Env.Kubeconfig, 0o600); err != nil {
		return fmt.Errorf("couldn't make %s private: %w", c.Env.Kubeconfig, err)
	}
	c.Printf("%s is now readable by root only\n", c.Env.Kubeconfig)
	return nil
}

func lockdownRegistry(c *cli.Context) error {
	serviceType, err := c.KubectlOut("get", "svc", "zot", "-o", "jsonpath={.spec.type}")
	if err != nil {
		c.Printf("no installer registry in this cluster, nothing to lock down\n")
		return nil
	}

	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}

	port, err := registryPort()
	if err != nil {
		return err
	}

	password, _ := values.Get("builders.harbor.password").(string)
	minted := false
	if password == "" {
		password, err = mintHex(24)
		if err != nil {
			return err
		}
		minted = true
	}
	values.Set("builders.harbor.username", registryUser)
	values.SetList("builders.harbor.hosts", []any{registryClusterHost})
	harbor, _ := values.Get("builders.harbor").(map[string]any)
	harbor["password"] = password
	values.SetEnv(serverEnvPath, "HARBOR_USERNAME", registryUser)
	values.SetEnv(serverEnvPath, "HARBOR_PASSWORD", password)
	if err := values.Save(); err != nil {
		return err
	}

	_, secretErr := c.KubectlOut("get", "secret", "zot-auth", "-o", "name")
	if minted || secretErr != nil {
		c.Printf("generating registry credentials\n")
		line, err := htpasswdLine(c, password)
		if err != nil {
			return err
		}
		if err := c.RunWithInput(zotAuthSecret(line), "kubectl", "-n", c.Env.Namespace, "apply", "-f", "-"); err != nil {
			return err
		}
	}

	if err := c.RunWithInput(zotConfigMap(), "kubectl", "-n", c.Env.Namespace, "apply", "-f", "-"); err != nil {
		return err
	}
	if err := c.Kubectl("patch", "deploy", "zot", "--type=strategic", "-p", zotDeploymentPatch(port)); err != nil {
		return err
	}
	if strings.TrimSpace(serviceType) != "ClusterIP" {
		if err := c.Kubectl("patch", "svc", "zot", "-p", `{"spec":{"type":"ClusterIP","ports":[{"port":5000,"nodePort":null}]}}`); err != nil {
			return err
		}
	}

	pullHost := values.EnvValue(serverEnvPath, "DOCKER_REGISTRY_PULL")
	if pullHost == "" {
		pullHost = "registry.orchard.local"
	}
	mirror := registriesYaml(pullHost, port, password)
	current, _ := os.ReadFile(registriesYamlPath)
	if string(current) != mirror {
		if err := os.WriteFile(registriesYamlPath, []byte(mirror), 0o600); err != nil {
			return fmt.Errorf("couldn't write %s: %w", registriesYamlPath, err)
		}
		c.Printf("restarting k3s with the authenticated registry mirror\n")
		if err := c.Run("systemctl", "restart", "k3s"); err != nil {
			return err
		}
		if err := c.Run("kubectl", "wait", "--for=condition=Ready", "node", "--all", "--timeout=3m"); err != nil {
			return err
		}
	}

	if err := c.Kubectl("rollout", "status", "deploy/zot", "--timeout=5m"); err != nil {
		return err
	}
	c.Printf("registry on 127.0.0.1:%d, loopback only, password required\n", port)
	return nil
}

func registryPort() (int, error) {
	port := registryDefaultPort
	if raw := os.Getenv("ORCHARD_REGISTRY_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			return 0, fmt.Errorf("ORCHARD_REGISTRY_PORT isn't a port: %s", raw)
		}
		port = parsed
	}
	lo, hi := nodePortRange()
	if port >= lo && port <= hi {
		return 0, fmt.Errorf("port %d falls inside the node port range %d-%d, where Kubernetes hands out its own; set ORCHARD_REGISTRY_PORT", port, lo, hi)
	}
	return port, nil
}

var nodePortFlag = regexp.MustCompile(`--service-node-port-range[= ]+(\d+)-(\d+)`)

func nodePortRange() (int, int) {
	raw, err := os.ReadFile(k3sUnitPath)
	if err == nil {
		if m := nodePortFlag.FindStringSubmatch(string(raw)); m != nil {
			lo, _ := strconv.Atoi(m[1])
			hi, _ := strconv.Atoi(m[2])
			return lo, hi
		}
	}
	return 30000, 32767
}

func mintHex(bytes int) (string, error) {
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("couldn't create a registry password: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func htpasswdLine(c *cli.Context, password string) (string, error) {
	var out string
	var err error
	if _, lookErr := exec.LookPath("htpasswd"); lookErr == nil {
		out, err = c.Capture("htpasswd", "-nbB", registryUser, password)
	} else {
		out, err = c.Capture("kubectl", "-n", c.Env.Namespace, "run", "zot-htpasswd", "--rm", "-i", "--quiet",
			"--restart=Never", "--image=httpd:2.4.71-alpine@sha256:32bd0639bcc4917ef1fd9363a1d9dd2dd9c498565118b062a10d51e43a5c3a24", "--command", "--", "htpasswd", "-nbB", registryUser, password)
	}
	if err != nil {
		return "", fmt.Errorf("couldn't hash the registry password: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, registryUser+":") {
			return line, nil
		}
	}
	return "", fmt.Errorf("htpasswd produced no entry for %s", registryUser)
}

func zotAuthSecret(line string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: zot-auth
  namespace: orchard
stringData:
  htpasswd: %q
`, line)
}

func zotConfigMap() string {
	return `apiVersion: v1
kind: ConfigMap
metadata:
  name: zot-config
  namespace: orchard
data:
  config.json: |
    {
      "storage": {
        "rootDirectory": "/var/lib/registry",
        "gc": true,
        "gcDelay": "1h",
        "gcInterval": "24h"
      },
      "http": {
        "address": "0.0.0.0",
        "port": "5000",
        "auth": { "htpasswd": { "path": "/etc/zot-auth/htpasswd" } }
      },
      "log": { "level": "info" },
      "extensions": {
        "scrub": { "interval": "24h" }
      }
    }
`
}

func zotDeploymentPatch(port int) string {
	return fmt.Sprintf(`{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null},"template":{"spec":{"containers":[{"name":"zot","ports":[{"containerPort":5000,"hostPort":%d,"hostIP":"127.0.0.1"}],"volumeMounts":[{"name":"auth","mountPath":"/etc/zot-auth","readOnly":true}]}],"volumes":[{"name":"auth","secret":{"secretName":"zot-auth"}}]}}}}`, port)
}

func registriesYaml(pullHost string, port int, password string) string {
	return fmt.Sprintf(`mirrors:
  %s:
    endpoint:
      - "http://127.0.0.1:%d"
configs:
  "127.0.0.1:%d":
    auth:
      username: %s
      password: %q
`, pullHost, port, port, registryUser, password)
}

func ensureFirewall(c *cli.Context) error {
	values, err := cli.LoadValues(c.Env.Values)
	if err != nil {
		return err
	}
	httpPort := envOr(values.EnvValue(serverEnvPath, "PUBLIC_HTTP_PORT"), "80")
	httpsPort := envOr(values.EnvValue(serverEnvPath, "PUBLIC_HTTPS_PORT"), "443")
	lo, hi := nodePortRange()
	_, tunnelErr := c.KubectlOut("get", "deploy", "cloudflared", "-o", "name")
	tunnel := tunnelErr == nil

	sources := append(lanCIDRs(c), tailscaleCIDR)

	switch {
	case ufwActive(c):
		c.Printf("opening ufw for k3s and Orchard\n")
		rules := [][]string{
			{"allow", "from", podCIDR, "to", "any", "comment", "k3s pods"},
			{"allow", "from", serviceCIDR, "to", "any", "comment", "k3s services"},
		}
		for _, cidr := range sources {
			rules = append(rules, []string{"allow", "from", cidr, "to", "any", "port", "6443", "proto", "tcp", "comment", "kubernetes api"})
		}
		if !tunnel {
			rules = append(rules,
				[]string{"allow", httpPort + "/tcp", "comment", "orchard http"},
				[]string{"allow", httpsPort + "/tcp", "comment", "orchard https"},
				[]string{"allow", fmt.Sprintf("%d:%d/tcp", lo, hi), "comment", "orchard app ports"},
				[]string{"allow", fmt.Sprintf("%d:%d/udp", lo, hi), "comment", "orchard app ports"},
			)
		}
		for _, rule := range rules {
			if _, err := c.Capture("ufw", rule...); err != nil {
				return fmt.Errorf("ufw %s: %w", strings.Join(rule, " "), err)
			}
		}
	case firewalldActive(c):
		c.Printf("opening firewalld for k3s and Orchard\n")
		rules := [][]string{
			{"--permanent", "--zone=trusted", "--add-source=" + podCIDR},
			{"--permanent", "--zone=trusted", "--add-source=" + serviceCIDR},
		}
		for _, cidr := range sources {
			rules = append(rules, []string{"--permanent", "--add-rich-rule=rule family=ipv4 source address=" + cidr + " port port=6443 protocol=tcp accept"})
		}
		if !tunnel {
			rules = append(rules,
				[]string{"--permanent", "--add-port=" + httpPort + "/tcp"},
				[]string{"--permanent", "--add-port=" + httpsPort + "/tcp"},
				[]string{"--permanent", fmt.Sprintf("--add-port=%d-%d/tcp", lo, hi)},
				[]string{"--permanent", fmt.Sprintf("--add-port=%d-%d/udp", lo, hi)},
			)
		}
		rules = append(rules, []string{"--reload"})
		for _, rule := range rules {
			if _, err := c.Capture("firewall-cmd", rule...); err != nil {
				return fmt.Errorf("firewall-cmd %s: %w", strings.Join(rule, " "), err)
			}
		}
	default:
		c.Printf("no host firewall active; install/README.md lists what this server listens on\n")
	}
	return nil
}

func ufwActive(c *cli.Context) bool {
	if _, err := exec.LookPath("ufw"); err != nil {
		return false
	}
	out, err := c.Capture("ufw", "status")
	return err == nil && strings.Contains(out, "Status: active")
}

func firewalldActive(c *cli.Context) bool {
	if _, err := exec.LookPath("firewall-cmd"); err != nil {
		return false
	}
	_, err := c.Capture("firewall-cmd", "--state")
	return err == nil
}

var linkRoute = regexp.MustCompile(`^(\S+/\d+) dev (\S+)`)

func lanCIDRs(c *cli.Context) []string {
	out, err := c.Capture("ip", "-4", "route", "show", "scope", "link")
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var cidrs []string
	for _, line := range strings.Split(out, "\n") {
		m := linkRoute.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || virtualInterface(m[2]) || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		cidrs = append(cidrs, m[1])
	}
	return cidrs
}

func virtualInterface(name string) bool {
	for _, prefix := range []string{"cni", "flannel", "veth", "docker", "br-", "lo", "tailscale"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func envOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
