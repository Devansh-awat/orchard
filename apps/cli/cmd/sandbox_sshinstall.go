package cmd

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/sshkey"
)

var sshHomeDir = os.UserHomeDir

const orchardSSHInclude = "Include ~/.orchard/ssh/config"

type orchardSSHPaths struct {
	Home string
}

func (p orchardSSHPaths) Dir() string           { return filepath.Join(p.Home, ".orchard", "ssh") }
func (p orchardSSHPaths) Key() string           { return filepath.Join(p.Dir(), "id_ed25519") }
func (p orchardSSHPaths) PublicKey() string     { return p.Key() + ".pub" }
func (p orchardSSHPaths) Config() string        { return filepath.Join(p.Dir(), "config") }
func (p orchardSSHPaths) UserSSHConfig() string { return filepath.Join(p.Home, ".ssh", "config") }

func ensureOrchardSSHKey(p orchardSSHPaths, comment string) (string, bool, error) {
	if err := os.MkdirAll(p.Dir(), 0o700); err != nil {
		return "", false, err
	}
	if err := os.Chmod(p.Dir(), 0o700); err != nil {
		return "", false, err
	}
	priv, err := os.ReadFile(p.Key())
	if err == nil {
		if pub, perr := os.ReadFile(p.PublicKey()); perr == nil {
			if line := strings.TrimSpace(string(pub)); line != "" {
				return line, false, nil
			}
		}
		line, derr := sshkey.AuthorizedKeyFromPrivate(priv, comment)
		if derr != nil {
			return "", false, fmt.Errorf("%s exists but its public key could not be read (%v); move it aside and rerun", p.Key(), derr)
		}
		if werr := os.WriteFile(p.PublicKey(), []byte(line+"\n"), 0o644); werr != nil {
			return "", false, werr
		}
		return line, false, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", false, err
	}
	privPEM, pub, err := sshkey.Generate(comment)
	if err != nil {
		return "", false, err
	}
	f, err := os.OpenFile(p.Key(), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", false, err
	}
	if _, err := f.Write(privPEM); err != nil {
		f.Close()
		return "", false, err
	}
	if err := f.Close(); err != nil {
		return "", false, err
	}
	if err := os.WriteFile(p.PublicKey(), []byte(pub+"\n"), 0o644); err != nil {
		return "", false, err
	}
	return pub, true, nil
}

func proxyCommandExecutable(exe string) (string, error) {
	if runtime.GOOS == "windows" {
		exe = filepath.ToSlash(exe)
	}
	if strings.ContainsAny(exe, "\"`$\\\n\r") {
		return "", fmt.Errorf("orchard is installed at %q, which cannot be quoted safely in an ssh ProxyCommand; move the binary and rerun", exe)
	}
	return strings.ReplaceAll(exe, "%", "%%"), nil
}

func renderOrchardSSHConfig(exe string) (string, error) {
	quoted, err := proxyCommandExecutable(exe)
	if err != nil {
		return "", err
	}
	lines := []string{
		"Host orchard-*",
		"  User dev",
		"  IdentityFile ~/.orchard/ssh/id_ed25519",
		"  IdentitiesOnly yes",
		"  ProxyCommand \"" + quoted + "\" sandbox proxy --host %n",
		"  StrictHostKeyChecking accept-new",
		"  UserKnownHostsFile ~/.orchard/ssh/known_hosts",
		"  ServerAliveInterval 30",
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func writeOrchardSSHConfig(p orchardSSHPaths, exe string) (bool, error) {
	content, err := renderOrchardSSHConfig(exe)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(p.Dir(), 0o700); err != nil {
		return false, err
	}
	if existing, err := os.ReadFile(p.Config()); err == nil && string(existing) == content {
		return false, nil
	}
	if err := os.WriteFile(p.Config(), []byte(content), 0o600); err != nil {
		return false, err
	}
	return true, os.Chmod(p.Config(), 0o600)
}

func sshConfigKeyword(line string) (string, string) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", ""
	}
	i := strings.IndexAny(line, " \t=")
	if i < 0 {
		return strings.ToLower(line), ""
	}
	rest := strings.TrimLeft(line[i:], " \t")
	rest = strings.TrimPrefix(rest, "=")
	return strings.ToLower(line[:i]), strings.TrimSpace(rest)
}

func hasOrchardSSHInclude(content string, p orchardSSHPaths) bool {
	targets := map[string]bool{
		"~/.orchard/ssh/config":      true,
		p.Config():                   true,
		filepath.ToSlash(p.Config()): true,
	}
	sc := bufio.NewScanner(strings.NewReader(content))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		key, rest := sshConfigKeyword(sc.Text())
		switch key {
		case "host", "match":
			return false
		case "include":
			for _, f := range strings.Fields(rest) {
				if targets[strings.Trim(f, "\"")] {
					return true
				}
			}
		}
	}
	return false
}

func ensureOrchardSSHInclude(p orchardSSHPaths) (bool, error) {
	path := p.UserSSHConfig()
	dir := filepath.Dir(path)
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return false, err
		}
	}
	mode := fs.FileMode(0o600)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if info, serr := os.Stat(path); serr == nil {
			mode = info.Mode().Perm()
		}
	case errors.Is(err, fs.ErrNotExist):
	default:
		return false, err
	}
	content := string(data)
	if hasOrchardSSHInclude(content, p) {
		return false, nil
	}
	next := orchardSSHInclude + "\n"
	if strings.TrimSpace(content) != "" {
		next += "\n" + content
	}
	return true, os.WriteFile(path, []byte(next), mode)
}

func sshIdentityNameForHost(host string) string {
	var b strings.Builder
	dash := false
	for _, r := range host {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if !ok {
			if !dash {
				b.WriteRune('-')
				dash = true
			}
			continue
		}
		b.WriteRune(r)
		dash = r == '-'
	}
	name := "orchard-cli"
	if h := strings.Trim(b.String(), "-._"); h != "" {
		name += "-" + h
	}
	if len(name) > 90 {
		name = strings.TrimRight(name[:90], "-._")
	}
	return name
}

func registerOrchardSSHIdentity(ctx context.Context, cl *api.Client, pub, host string) (string, bool, error) {
	raw, err := fetchSSHIdentities(ctx, cl)
	if err != nil {
		return "", false, err
	}
	names := map[string]bool{}
	for _, ident := range asList(raw["identities"]) {
		if sshkey.SameKey(str(ident["publicKey"]), pub) {
			return str(ident["name"]), false, nil
		}
		names[str(ident["name"])] = true
	}
	base := sshIdentityNameForHost(host)
	name := base
	for i := 2; names[name]; i++ {
		name = fmt.Sprintf("%s-%d", base, i)
	}
	var created map[string]any
	if err := cl.Send(ctx, http.MethodPost, "/ssh-identities", map[string]any{"name": name, "publicKey": pub}, &created); err != nil {
		return "", false, sandboxFeatureError(err)
	}
	if n := str(created["name"]); n != "" {
		name = n
	}
	return name, true, nil
}

func orchardExecutablePath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if len(os.Args) > 0 && !strings.ContainsRune(os.Args[0], filepath.Separator) {
		if found, lerr := exec.LookPath(os.Args[0]); lerr == nil {
			if abs, aerr := filepath.Abs(found); aerr == nil {
				a, aerr := os.Stat(abs)
				b, berr := os.Stat(exe)
				if aerr == nil && berr == nil && os.SameFile(a, b) {
					return abs, nil
				}
			}
		}
	}
	return filepath.Abs(exe)
}

type sshInstallResult struct {
	KeyPath         string `json:"keyPath"`
	KeyCreated      bool   `json:"keyCreated"`
	PublicKey       string `json:"publicKey"`
	Identity        string `json:"identity"`
	IdentityCreated bool   `json:"identityCreated"`
	ConfigPath      string `json:"configPath"`
	ConfigChanged   bool   `json:"configChanged"`
	SSHConfigPath   string `json:"sshConfigPath"`
	IncludeAdded    bool   `json:"includeAdded"`
	Example         string `json:"example"`
}

func installOrchardSSH(ctx context.Context, cl *api.Client) (*sshInstallResult, error) {
	home, err := sshHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate home directory: %w", err)
	}
	p := orchardSSHPaths{Home: home}
	exe, err := orchardExecutablePath()
	if err != nil {
		return nil, err
	}
	if _, err := proxyCommandExecutable(exe); err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	pub, keyCreated, err := ensureOrchardSSHKey(p, "orchard-cli@"+host)
	if err != nil {
		return nil, fmt.Errorf("ssh key: %w", err)
	}
	identity, identityCreated, err := registerOrchardSSHIdentity(ctx, cl, pub, host)
	if err != nil {
		return nil, fmt.Errorf("register ssh identity: %w", err)
	}
	configChanged, err := writeOrchardSSHConfig(p, exe)
	if err != nil {
		return nil, fmt.Errorf("write %s: %w", p.Config(), err)
	}
	includeAdded, err := ensureOrchardSSHInclude(p)
	if err != nil {
		return nil, fmt.Errorf("update %s: %w", p.UserSSHConfig(), err)
	}
	example := "ssh orchard-<name>"
	if raw, ferr := fetchSandboxes(ctx, cl); ferr == nil {
		if items := asList(raw["sandboxes"]); len(items) > 0 && str(items[0]["name"]) != "" {
			example = "ssh orchard-" + str(items[0]["name"])
		}
	}
	return &sshInstallResult{
		KeyPath:         p.Key(),
		KeyCreated:      keyCreated,
		PublicKey:       pub,
		Identity:        identity,
		IdentityCreated: identityCreated,
		ConfigPath:      p.Config(),
		ConfigChanged:   configChanged,
		SSHConfigPath:   p.UserSSHConfig(),
		IncludeAdded:    includeAdded,
		Example:         example,
	}, nil
}

func printSSHInstallResult(r *sshInstallResult) error {
	if fmtFlag() == output.FormatJSON {
		return output.JSON(r)
	}
	if r.KeyCreated {
		output.Successf("generated %s", r.KeyPath)
	} else {
		output.Successf("using existing key %s", r.KeyPath)
	}
	if r.IdentityCreated {
		output.Successf("registered ssh identity %s", r.Identity)
	} else {
		output.Successf("ssh identity %s already registered", r.Identity)
	}
	output.Successf("wrote %s", r.ConfigPath)
	if r.IncludeAdded {
		output.Successf("added %q to the top of %s", orchardSSHInclude, r.SSHConfigPath)
	} else {
		output.Successf("%s already includes the orchard config", r.SSHConfigPath)
	}
	fmt.Println()
	fmt.Println("connect with:  " + r.Example)
	fmt.Println(output.Dim("the Open in VS Code / Cursor / Zed links in the web UI now work on this machine"))
	return nil
}
