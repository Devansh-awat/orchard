package guest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

type collector struct {
	mu  sync.Mutex
	evs []proto.Event
}

func (c *collector) emit(ev proto.Event) {
	c.mu.Lock()
	c.evs = append(c.evs, ev)
	c.mu.Unlock()
}

func (c *collector) text(stream string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var b strings.Builder
	for _, e := range c.evs {
		if e.Type == proto.EventLog && e.Stream == stream {
			b.WriteString(e.Data)
		}
	}
	return b.String()
}

func makeRepo(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o644)
	run("add", ".")
	run("commit", "-q", "-m", "one")
	return dir, "file://" + dir
}

func commit(t *testing.T, dir, file, body string) {
	os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644)
	for _, args := range [][]string{{"add", "."}, {"commit", "-q", "-m", file}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
}

func TestGitSourceThenStepsWithMirrorReuse(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	repo, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir(), BuildkitAddr: "unix:///run/buildkit/buildkitd.sock"}
	req := proto.BuildRequest{
		ID:     "b1",
		Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "main"},
		Steps: []proto.Step{
			{Name: "prepare", Script: "ls; echo \"marker=$MY_VAR\"", Env: map[string]string{"MY_VAR": "hello"}},
			{Name: "build", Script: "git rev-parse HEAD >/dev/null && echo built && echo \"$BUILDKIT_HOST\""},
		},
	}
	c := &collector{}
	timings, err := r.Run(context.Background(), req, c.emit)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, c.text("source"))
	}
	if !strings.Contains(c.text("prepare"), "Dockerfile") || !strings.Contains(c.text("prepare"), "marker=hello") {
		t.Fatalf("prepare output: %q", c.text("prepare"))
	}
	if !strings.Contains(c.text("build"), "built") || !strings.Contains(c.text("build"), "buildkitd.sock") {
		t.Fatalf("build output: %q", c.text("build"))
	}
	if _, ok := timings["sourceMs"]; !ok || timings["buildMs"] < 0 {
		t.Fatalf("timings %v", timings)
	}
	if _, err := os.Stat(filepath.Join(r.CacheDir, "work", "b1")); !os.IsNotExist(err) {
		t.Fatal("workspace not cleaned up")
	}

	commit(t, repo, "app.txt", "v2")
	req.ID = "b2"
	req.Steps = []proto.Step{{Name: "build", Script: "cat app.txt"}}
	c2 := &collector{}
	if _, err := r.Run(context.Background(), req, c2.emit); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if !strings.Contains(c2.text("build"), "v2") {
		t.Fatalf("mirror did not pick up new commit: %q", c2.text("build"))
	}
	mirrors, _ := filepath.Glob(filepath.Join(r.CacheDir, "git", "*.git"))
	if len(mirrors) != 1 {
		t.Fatalf("mirrors: %v", mirrors)
	}
}

func TestFailingStepReportsExitCode(t *testing.T) {
	_, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir()}
	req := proto.BuildRequest{ID: "b", Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "main"},
		Steps: []proto.Step{{Name: "build", Script: "echo boom; exit 3"}}}
	_, err := r.Run(context.Background(), req, (&collector{}).emit)
	if err == nil || !strings.Contains(err.Error(), "exit 3") {
		t.Fatalf("got %v", err)
	}
}

func TestDockerConfigReachesStepsAndIsRemoved(t *testing.T) {
	_, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir()}
	cfg := `{"auths":{"dhi.io":{"username":"u","password":"p","auth":"dTpw"}}}`
	req := proto.BuildRequest{ID: "b", Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "main"},
		DockerConfig: []byte(cfg),
		Steps:        []proto.Step{{Name: "build", Script: `echo "dir=$DOCKER_CONFIG"; cat "$DOCKER_CONFIG/config.json"`}}}
	c := &collector{}
	if _, err := r.Run(context.Background(), req, c.emit); err != nil {
		t.Fatalf("run: %v", err)
	}
	out := c.text("build")
	if !strings.Contains(out, `"dhi.io"`) {
		t.Fatalf("docker config not visible to step: %q", out)
	}
	dir := strings.TrimSpace(strings.SplitN(strings.TrimPrefix(out, "dir="), "\n", 2)[0])
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("docker config dir %q left behind", dir)
	}
}

func TestEmptyDockerConfigWhenNoneSent(t *testing.T) {
	_, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir()}
	req := proto.BuildRequest{ID: "b", Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "main"},
		Steps: []proto.Step{{Name: "build", Script: `cat "$DOCKER_CONFIG/config.json"`}}}
	c := &collector{}
	if _, err := r.Run(context.Background(), req, c.emit); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.TrimSpace(c.text("build")) != "{}" {
		t.Fatalf("got %q", c.text("build"))
	}
}

func TestBadBranchFailsCleanly(t *testing.T) {
	_, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir()}
	req := proto.BuildRequest{ID: "b", Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "nope"},
		Steps: []proto.Step{{Name: "build", Script: "true"}}}
	if _, err := r.Run(context.Background(), req, (&collector{}).emit); err == nil {
		t.Fatal("expected fetch failure")
	}
}

func TestCancelKillsStepProcessGroup(t *testing.T) {
	_, url := makeRepo(t)
	r := &Runner{CacheDir: t.TempDir()}
	req := proto.BuildRequest{ID: "b", Source: proto.Source{Kind: proto.SourceGit, CloneURL: url, Branch: "main"},
		Steps: []proto.Step{{Name: "build", Script: "sleep 30 & sleep 30; wait"}}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := r.Run(ctx, req, (&collector{}).emit); done <- err }()
	time.Sleep(500 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("step not killed")
	}
}

func TestMaskingHidesToken(t *testing.T) {
	if got := maskURL("https://x-access-token:ghs_secret@github.com/a/b"); strings.Contains(got, "ghs_secret") {
		t.Fatalf("leaked: %s", got)
	}
	if got := stripUser("https://u:p@github.com/a/b"); got != "https://github.com/a/b" {
		t.Fatalf("strip: %s", got)
	}
	if got := baseURL("https://u:p@github.com/a/b", false); got != "https://github.com/" {
		t.Fatalf("base: %s", got)
	}
}

func tarball(t *testing.T, entries []tar.Header, bodies map[string]string) *bytes.Buffer {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range entries {
		h := h
		body := bodies[h.Name]
		h.Size = int64(len(body))
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		tw.WriteHeader(&h)
		tw.Write([]byte(body))
	}
	tw.Close()
	gz.Close()
	return &buf
}

func TestExtractRejectsEscapes(t *testing.T) {
	cases := map[string][]tar.Header{
		"dotdot":   {{Name: "../evil", Typeflag: tar.TypeReg}},
		"absolute": {{Name: "/etc/evil", Typeflag: tar.TypeReg}},
		"via link": {{Name: "l", Typeflag: tar.TypeSymlink, Linkname: "/etc"}, {Name: "l/passwd", Typeflag: tar.TypeReg}},
	}
	for name, entries := range cases {
		if err := Extract(tarball(t, entries, nil), t.TempDir()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	dest := t.TempDir()
	ok := []tar.Header{{Name: "src/", Typeflag: tar.TypeDir, Mode: 0o755}, {Name: "src/a.txt", Typeflag: tar.TypeReg}}
	if err := Extract(tarball(t, ok, map[string]string{"src/a.txt": "hi"}), dest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "src/a.txt")); string(b) != "hi" {
		t.Fatalf("content %q", b)
	}
}
