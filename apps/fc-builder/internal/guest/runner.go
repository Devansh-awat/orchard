package guest

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

const chunkSize = 64 * 1024

type Emit func(proto.Event)

type Runner struct {
	CacheDir     string
	BuildkitAddr string
	Workspace    string
	MetaPath     string
	Isolate      bool
	HTTP         *http.Client

	mirrorMu sync.Mutex
	mirrors  map[string]*sync.Mutex
}

func (r *Runner) mirrorLock(key string) *sync.Mutex {
	r.mirrorMu.Lock()
	defer r.mirrorMu.Unlock()
	if r.mirrors == nil {
		r.mirrors = map[string]*sync.Mutex{}
	}
	m, ok := r.mirrors[key]
	if !ok {
		m = &sync.Mutex{}
		r.mirrors[key] = m
	}
	return m
}

func (r *Runner) Run(ctx context.Context, req proto.BuildRequest, emit Emit) (map[string]int64, error) {
	timings := map[string]int64{}
	work := filepath.Join(r.CacheDir, "work", req.ID)
	meta := filepath.Join(r.CacheDir, "meta", req.ID)
	dockerDir := filepath.Join(r.CacheDir, "meta", req.ID+"-docker")
	defer func() {
		os.RemoveAll(work)
		os.RemoveAll(meta)
		os.RemoveAll(dockerDir)
	}()
	for _, d := range []string{filepath.Dir(work), meta, dockerDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return timings, err
		}
	}
	os.RemoveAll(work)
	dockerCfg := []byte("{}")
	if len(req.DockerConfig) > 0 {
		dockerCfg = req.DockerConfig
	}
	if err := os.WriteFile(filepath.Join(dockerDir, "config.json"), dockerCfg, 0o600); err != nil {
		return timings, err
	}

	emit(proto.Phase(proto.PhaseSource))
	start := time.Now()
	var err error
	switch req.Source.Kind {
	case proto.SourceGit:
		err = r.gitSource(ctx, req.Source, work, emit)
	case proto.SourceContext:
		err = r.contextSource(ctx, req.Source.ContextURL, work, emit)
	default:
		err = fmt.Errorf("unknown source kind %q", req.Source.Kind)
	}
	timings["sourceMs"] = time.Since(start).Milliseconds()
	if err != nil {
		return timings, err
	}

	for _, step := range req.Steps {
		emit(proto.Phase(step.Name))
		start := time.Now()
		err := r.runStep(ctx, step, work, meta, dockerDir, emit)
		timings[step.Name+"Ms"] = time.Since(start).Milliseconds()
		if err != nil {
			return timings, err
		}
	}
	return timings, nil
}

func maskURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = url.User("***")
	return u.String()
}

func stripUser(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.User = nil
	return u.String()
}

func baseURL(raw string, withUser bool) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	b := &url.URL{Scheme: u.Scheme, Host: u.Host, Path: "/"}
	if withUser {
		b.User = u.User
	}
	return b.String()
}

func (r *Runner) git(ctx context.Context, dir string, emit Emit, secret string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_LFS_SKIP_SMUDGE=1")
	out, err := cmd.CombinedOutput()
	text := string(out)
	if secret != "" {
		text = strings.ReplaceAll(text, secret, "***")
	}
	if strings.TrimSpace(text) != "" && emit != nil {
		emit(proto.Log(proto.PhaseSource, text))
	}
	if err != nil {
		return fmt.Errorf("git %s failed: %w", args[0], err)
	}
	return nil
}

func (r *Runner) gitSource(ctx context.Context, src proto.Source, work string, emit Emit) error {
	plain := stripUser(src.CloneURL)
	secret := ""
	if u, err := url.Parse(src.CloneURL); err == nil && u.User != nil {
		secret = u.User.String()
	}
	emit(proto.Log(proto.PhaseSource, fmt.Sprintf("=== Fetching source ===\nRepository: %s\nBranch: %s\n", maskURL(src.CloneURL), src.Branch)))
	sum := sha256.Sum256([]byte(plain))
	key := hex.EncodeToString(sum[:12])
	mirror := filepath.Join(r.CacheDir, "git", key+".git")
	lock := r.mirrorLock(key)
	lock.Lock()
	if _, err := os.Stat(mirror); err != nil {
		if err := os.MkdirAll(filepath.Dir(mirror), 0o700); err != nil {
			lock.Unlock()
			return err
		}
		if err := r.git(ctx, "", nil, "", "init", "-q", "--bare", mirror); err != nil {
			lock.Unlock()
			return err
		}
	}
	ref := "+refs/heads/" + src.Branch + ":refs/heads/" + src.Branch
	fetchErr := r.git(ctx, mirror, emit, secret, "fetch", "-q", "--depth", "1", "--force", "--no-tags", src.CloneURL, ref)
	if fetchErr == nil {
		fetchErr = r.git(ctx, "", emit, secret, "clone", "-q", "--local", "--branch", src.Branch, "--single-branch", mirror, work)
	}
	if fetchErr == nil {
		r.git(ctx, mirror, nil, "", "gc", "--auto", "--quiet")
	}
	lock.Unlock()
	if fetchErr != nil {
		emit(proto.Log(proto.PhaseSource, "Clone failed. If this repository is private, check that the GitHub connection can still read it.\n"))
		return errors.New("could not fetch the repository")
	}
	r.git(ctx, work, nil, "", "remote", "set-url", "origin", plain)
	insteadOf := []string{}
	if secret != "" {
		insteadOf = []string{"-c", "url." + baseURL(src.CloneURL, true) + ".insteadOf=" + baseURL(src.CloneURL, false)}
	}
	if _, err := os.Stat(filepath.Join(work, ".gitmodules")); err == nil {
		args := append(append([]string{}, insteadOf...), "submodule", "update", "--init", "--recursive", "--depth", "1")
		if err := r.git(ctx, work, emit, secret, args...); err != nil {
			return errors.New("could not fetch submodules")
		}
	}
	if attrs, err := os.ReadFile(filepath.Join(work, ".gitattributes")); err == nil && strings.Contains(string(attrs), "filter=lfs") {
		args := append(append([]string{}, insteadOf...), "lfs", "pull")
		if err := r.git(ctx, work, emit, secret, args...); err != nil {
			emit(proto.Log(proto.PhaseSource, "git-lfs: pull failed, LFS files stay as pointers\n"))
		}
	}
	if sha, err := exec.CommandContext(ctx, "git", "-C", work, "rev-parse", "HEAD").Output(); err == nil {
		emit(proto.Log(proto.PhaseSource, "Commit: "+strings.TrimSpace(string(sha))+"\n"))
	}
	return nil
}

func (r *Runner) contextSource(ctx context.Context, contextURL, work string, emit Emit) error {
	emit(proto.Log(proto.PhaseSource, "=== Fetching uploaded source ===\n"))
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, contextURL, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("could not download the uploaded source")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("uploaded source download returned %d", resp.StatusCode)
	}
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	return Extract(io.LimitReader(resp.Body, 2<<30), work)
}

func Extract(r io.Reader, dest string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return errors.New("uploaded source is not a gzip tarball")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	links := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(strings.TrimPrefix(hdr.Name, "./"))
		if name == "." {
			continue
		}
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
			return fmt.Errorf("unsafe path in upload: %s", hdr.Name)
		}
		for p := filepath.Dir(name); p != "." && p != "/"; p = filepath.Dir(p) {
			if links[p] {
				return fmt.Errorf("upload writes through a symlink: %s", hdr.Name)
			}
		}
		target := filepath.Join(dest, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(hdr.Mode)&0o755|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
			links[name] = true
		}
	}
}

type eventWriter struct {
	stream string
	emit   Emit
}

func (w *eventWriter) Write(p []byte) (int, error) {
	for off := 0; off < len(p); off += chunkSize {
		end := min(off+chunkSize, len(p))
		w.emit(proto.Log(w.stream, string(p[off:end])))
	}
	return len(p), nil
}

func (r *Runner) stepEnv(step proto.Step, work, meta, dockerDir string) []string {
	env := []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
		"LANG=C.UTF-8",
		"BUILDKIT_HOST=" + r.BuildkitAddr,
		"DOCKER_CONFIG=" + dockerDir,
		"FC_WORK=" + work,
		"FC_META=" + meta,
	}
	for k, v := range step.Env {
		env = append(env, k+"="+v)
	}
	return env
}

func (r *Runner) runStep(ctx context.Context, step proto.Step, work, meta, dockerDir string, emit Emit) error {
	script := filepath.Join(meta, "step-"+step.Name+".sh")
	if err := os.WriteFile(script, []byte(step.Script), 0o700); err != nil {
		return err
	}
	var cmd *exec.Cmd
	if r.Isolate {
		wrapper := `mount --bind "$FC_WORK" ` + r.Workspace + ` && mount --bind "$FC_META" ` + r.MetaPath + ` && cd ` + r.Workspace + ` && exec /bin/sh "$1"`
		cmd = exec.CommandContext(ctx, "unshare", "-m", "--propagation", "private", "/bin/sh", "-c", wrapper, "fc-step", script)
	} else {
		cmd = exec.CommandContext(ctx, "/bin/sh", script)
		cmd.Dir = work
	}
	cmd.Env = r.stepEnv(step, work, meta, dockerDir)
	w := &eventWriter{stream: step.Name, emit: emit}
	cmd.Stdout, cmd.Stderr = w, w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("%s step failed (exit %d)", step.Name, exit.ExitCode())
		}
		return fmt.Errorf("%s step failed: %w", step.Name, err)
	}
	return nil
}
