//go:build !windows

package agentd

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Identity struct {
	Name  string
	Home  string
	Shell string
	cred  *syscall.Credential
}

func ResolveIdentity(name string) (*Identity, error) {
	if name == "" {
		u, err := user.Current()
		if err != nil {
			return nil, err
		}
		return &Identity{Name: u.Username, Home: u.HomeDir, Shell: loginShell(u.Username)}, nil
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil, err
	}
	id := &Identity{Name: u.Username, Home: u.HomeDir, Shell: loginShell(u.Username)}
	if os.Geteuid() == 0 {
		uid, _ := strconv.ParseUint(u.Uid, 10, 32)
		gid, _ := strconv.ParseUint(u.Gid, 10, 32)
		if uid != 0 {
			groups := []uint32{}
			if ids, err := u.GroupIds(); err == nil {
				for _, g := range ids {
					if n, err := strconv.ParseUint(g, 10, 32); err == nil {
						groups = append(groups, uint32(n))
					}
				}
			}
			id.cred = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: groups}
		}
	}
	return id, nil
}

func loginShell(name string) string {
	data, err := os.ReadFile("/etc/passwd")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			parts := strings.Split(line, ":")
			if len(parts) >= 7 && parts[0] == name && parts[6] != "" {
				return parts[6]
			}
		}
	}
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash"
	}
	return "/bin/sh"
}

func (id *Identity) Prepare(cmd *exec.Cmd, newGroup bool) {
	attr := &syscall.SysProcAttr{Setpgid: newGroup}
	if id.cred != nil {
		attr.Credential = id.cred
	}
	cmd.SysProcAttr = attr
}

type LoginEnv struct {
	id      *Identity
	mu      sync.Mutex
	env     []string
	stamp   string
	checked time.Time
}

func NewLoginEnv(id *Identity) *LoginEnv {
	return &LoginEnv{id: id}
}

func (l *LoginEnv) sources() []string {
	out := []string{"/etc/profile", "/etc/environment"}
	if matches, _ := filepath.Glob("/etc/profile.d/*.sh"); len(matches) > 0 {
		out = append(out, matches...)
	}
	for _, f := range []string{".profile", ".bash_profile", ".bash_login", ".bashrc"} {
		out = append(out, filepath.Join(l.id.Home, f))
	}
	return out
}

func (l *LoginEnv) fingerprint() string {
	var b strings.Builder
	for _, f := range l.sources() {
		if st, err := os.Stat(f); err == nil {
			fmt.Fprintf(&b, "%s:%d:%d;", f, st.ModTime().UnixNano(), st.Size())
		}
	}
	return b.String()
}

func (l *LoginEnv) Get(ctx context.Context) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.env != nil && time.Since(l.checked) < time.Second {
		return l.env
	}
	stamp := l.fingerprint()
	l.checked = time.Now()
	if l.env != nil && stamp == l.stamp {
		return l.env
	}
	env, err := l.capture(ctx)
	if err != nil {
		if l.env != nil {
			return l.env
		}
		env = l.baseEnv()
	}
	l.env = env
	l.stamp = stamp
	return env
}

func (l *LoginEnv) baseEnv() []string {
	path := "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	return []string{
		"HOME=" + l.id.Home,
		"USER=" + l.id.Name,
		"LOGNAME=" + l.id.Name,
		"SHELL=" + l.id.Shell,
		"PATH=" + filepath.Join(l.id.Home, ".local/bin") + ":" + path,
		"LANG=C.UTF-8",
	}
}

func (l *LoginEnv) capture(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, l.id.Shell, "-l", "-c", "env -0")
	cmd.Env = l.baseEnv()
	cmd.Dir = l.id.Home
	cmd.Stdin = nil
	l.id.Prepare(cmd, true)
	cmd.WaitDelay = time.Second
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	env := []string{}
	for _, kv := range bytes.Split(out.Bytes(), []byte{0}) {
		s := string(kv)
		if s == "" || !strings.Contains(s, "=") {
			continue
		}
		key := s[:strings.IndexByte(s, '=')]
		if key == "_" || key == "SHLVL" || key == "PWD" || key == "OLDPWD" {
			continue
		}
		env = append(env, s)
	}
	sort.Strings(env)
	return env, nil
}

func mergeEnv(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}
	out := make([]string, 0, len(base)+len(extra))
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		if _, ok := extra[key]; ok {
			continue
		}
		out = append(out, kv)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return out
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for i := len(env) - 1; i >= 0; i-- {
		if strings.HasPrefix(env[i], prefix) {
			return env[i][len(prefix):]
		}
	}
	return ""
}

func lookPath(env []string, name string) string {
	if strings.Contains(name, "/") {
		if st, err := os.Stat(name); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return name
		}
		return ""
	}
	for _, dir := range filepath.SplitList(envValue(env, "PATH")) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}
