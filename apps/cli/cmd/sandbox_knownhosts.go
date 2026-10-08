package cmd

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
)

const sandboxHostKeyTimeout = 10 * time.Second

func (p orchardSSHPaths) KnownHosts() string { return filepath.Join(p.Dir(), "known_hosts") }

func fetchSandboxHostKeys(ctx context.Context, cl *api.Client, id string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, sandboxHostKeyTimeout)
	defer cancel()
	var raw struct {
		PublicKeys []string `json:"publicKeys"`
	}
	if err := cl.GetJSON(ctx, sandboxPath(id, "hostkey"), &raw); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(raw.PublicKeys))
	for _, k := range raw.PublicKeys {
		fields := strings.Fields(k)
		if len(fields) < 2 {
			continue
		}
		key := fields[0] + " " + fields[1]
		if !validHostKey(key) {
			continue
		}
		keys = append(keys, key)
	}
	return keys, nil
}

func hostKeysUnsupported(err error) bool {
	var apiErr *api.APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

func knownHostsLineMatches(hostsField, alias string) bool {
	for _, h := range strings.Split(hostsField, ",") {
		if strings.HasPrefix(h, "|1|") {
			parts := strings.Split(h, "|")
			if len(parts) != 4 {
				continue
			}
			salt, serr := base64.StdEncoding.DecodeString(parts[2])
			want, werr := base64.StdEncoding.DecodeString(parts[3])
			if serr != nil || werr != nil {
				continue
			}
			mac := hmac.New(sha1.New, salt)
			mac.Write([]byte(alias))
			if hmac.Equal(mac.Sum(nil), want) {
				return true
			}
			continue
		}
		if h == alias {
			return true
		}
	}
	return false
}

var (
	knownHostsAliasRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,252}$`)
	hostKeyRe         = regexp.MustCompile(`^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+={0,2}$`)
)

func validHostKey(key string) bool {
	return hostKeyRe.MatchString(key)
}

func rewriteKnownHosts(content, alias string, keys []string) string {
	if !knownHostsAliasRe.MatchString(alias) {
		return content
	}
	var kept []string
	sc := bufio.NewScanner(strings.NewReader(content))
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "@") {
			if fields := strings.Fields(trimmed); len(fields) > 0 && knownHostsLineMatches(fields[0], alias) {
				continue
			}
		}
		kept = append(kept, line)
	}
	for _, k := range keys {
		kept = append(kept, alias+" "+k)
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, "\n") + "\n"
}

func syncKnownHosts(path, alias string, keys []string) (bool, error) {
	if len(keys) == 0 {
		return false, nil
	}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	next := rewriteKnownHosts(string(data), alias, keys)
	if next == string(data) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".known_hosts-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(next); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	return true, os.Rename(tmp.Name(), path)
}

func refreshSandboxKnownHosts(ctx context.Context, cl *api.Client, id, alias string) (string, error) {
	home, err := sshHomeDir()
	if err != nil {
		return "", err
	}
	path := orchardSSHPaths{Home: home}.KnownHosts()
	keys, err := fetchSandboxHostKeys(ctx, cl, id)
	if err != nil {
		return path, err
	}
	if _, err := syncKnownHosts(path, alias, keys); err != nil {
		return path, fmt.Errorf("update %s: %w", path, err)
	}
	return path, nil
}
