//go:build !windows

package agentd

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var (
	repoNameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`)
	gitRefRE   = regexp.MustCompile(`^[A-Za-z0-9._/+-]{1,200}$`)
)

const (
	maxPoolRepos   = 3
	poolTick       = 2 * time.Minute
	minFreeDiskPct = 20
)

func validRepo(name string) bool {
	return repoNameRE.MatchString(name) && !strings.Contains(name, "..") && !strings.HasSuffix(name, ".lock")
}

func validRef(ref string) bool {
	if !gitRefRE.MatchString(ref) || strings.HasPrefix(ref, "-") || strings.HasPrefix(ref, "/") || strings.HasSuffix(ref, "/") {
		return false
	}
	if strings.Contains(ref, "..") || strings.Contains(ref, "//") || strings.Contains(ref, "@{") || strings.HasSuffix(ref, ".") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

type poolWant struct {
	Repo   string            `json:"repo"`
	Base   string            `json:"base,omitempty"`
	Agent  string            `json:"agent,omitempty"`
	Setup  string            `json:"setup,omitempty"`
	MCP    []json.RawMessage `json:"mcpServers,omitempty"`
	UsedAt int64             `json:"usedAt"`
}

type spare struct {
	Name      string `json:"name"`
	Repo      string `json:"repo"`
	Base      string `json:"base"`
	Path      string `json:"path"`
	Commit    string `json:"commit"`
	Setup     string `json:"setup"`
	Agent     string `json:"agent,omitempty"`
	AgentErr  string `json:"agentError,omitempty"`
	CreatedAt int64  `json:"createdAt"`

	proc     *AgentProc
	state    *acpSessionState
	setupCmd *exec.Cmd
}

type Pool struct {
	d       *Daemon
	mu      sync.Mutex
	wants   map[string]*poolWant
	spares  map[string]*spare
	busy    map[string]bool
	kick    chan struct{}
	off     bool
	minFree uint64
}

func NewPool(d *Daemon) *Pool {
	p := &Pool{d: d, wants: map[string]*poolWant{}, spares: map[string]*spare{}, busy: map[string]bool{}, kick: make(chan struct{}, 1), minFree: minFreeDiskPct}
	p.load()
	return p
}

func (p *Pool) dir() string {
	return filepath.Join(p.d.stateDir, "pool")
}

func (p *Pool) repoPath(repo string) string {
	return filepath.Join(p.d.id.Home, repo)
}

func (p *Pool) load() {
	if os.Getenv("ORCHARD_POOL_DISABLED") == "1" {
		p.off = true
	}
	raw, err := os.ReadFile(filepath.Join(p.dir(), "state.json"))
	if err != nil {
		return
	}
	var saved struct {
		Wants  []*poolWant `json:"wants"`
		Spares []*spare    `json:"spares"`
	}
	if json.Unmarshal(raw, &saved) != nil {
		return
	}
	for _, w := range saved.Wants {
		if validRepo(w.Repo) {
			p.wants[w.Repo] = w
		}
	}
	for _, s := range saved.Spares {
		if validRepo(s.Repo) && s.Path == p.sparePath(s.Repo, s.Name) {
			if st, err := os.Stat(s.Path); err == nil && st.IsDir() {
				s.Agent = ""
				if s.Setup == "running" {
					s.Setup = "pending"
				}
				p.spares[s.Repo] = s
			}
		}
	}
}

func (p *Pool) saveLocked() {
	wants := make([]*poolWant, 0, len(p.wants))
	for _, w := range p.wants {
		wants = append(wants, w)
	}
	spares := make([]*spare, 0, len(p.spares))
	for _, s := range p.spares {
		spares = append(spares, s)
	}
	raw, err := json.Marshal(map[string]any{"wants": wants, "spares": spares})
	if err != nil {
		return
	}
	_ = os.MkdirAll(p.dir(), 0o700)
	p.d.chown(p.dir())
	tmp := filepath.Join(p.dir(), ".state.json.tmp")
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(p.dir(), "state.json"))
		p.d.chown(filepath.Join(p.dir(), "state.json"))
	}
}

func (p *Pool) sparePath(repo, name string) string {
	return filepath.Join(p.d.id.Home, ".worktrees", repo, name)
}

type poolEnsureParams struct {
	Repo  string            `json:"repo"`
	Base  string            `json:"base,omitempty"`
	Agent string            `json:"agent,omitempty"`
	Setup string            `json:"setup,omitempty"`
	MCP   []json.RawMessage `json:"mcpServers,omitempty"`
}

func (p *Pool) Ensure(params poolEnsureParams) (any, error) {
	if !validRepo(params.Repo) {
		return nil, rpcErr(codeInvalidParams, "invalid repo")
	}
	if params.Base != "" && !validRef(params.Base) {
		return nil, rpcErr(codeInvalidParams, "invalid base")
	}
	p.mu.Lock()
	w := p.wants[params.Repo]
	if w == nil {
		w = &poolWant{Repo: params.Repo}
		p.wants[params.Repo] = w
	}
	w.Base = params.Base
	w.Agent = params.Agent
	w.Setup = params.Setup
	w.MCP = params.MCP
	w.UsedAt = time.Now().UnixMilli()
	p.trimLocked()
	if s := p.spares[params.Repo]; s != nil && s.Agent != params.Agent && s.proc != nil {
		s.proc.Kill()
		s.proc, s.state, s.Agent = nil, nil, ""
	}
	p.saveLocked()
	p.mu.Unlock()
	p.poke()
	return map[string]bool{"ok": true}, nil
}

func (p *Pool) trimLocked() {
	if len(p.wants) <= maxPoolRepos {
		return
	}
	list := make([]*poolWant, 0, len(p.wants))
	for _, w := range p.wants {
		list = append(list, w)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].UsedAt > list[j].UsedAt })
	for _, w := range list[maxPoolRepos:] {
		delete(p.wants, w.Repo)
		if s := p.spares[w.Repo]; s != nil {
			delete(p.spares, w.Repo)
			go p.discard(s)
		}
	}
}

func (p *Pool) poke() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

func (p *Pool) Run(ctx context.Context) {
	t := time.NewTicker(poolTick)
	defer t.Stop()
	p.poke()
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.kick:
			p.fill(ctx)
		case <-t.C:
			p.refresh(ctx)
			p.fill(ctx)
		}
	}
}

func (p *Pool) diskOK() bool {
	var st syscall.Statfs_t
	if syscall.Statfs(p.d.id.Home, &st) != nil || st.Blocks == 0 {
		return true
	}
	return st.Bavail*100/st.Blocks >= p.minFree
}

func (p *Pool) fill(ctx context.Context) {
	if p.off || !p.diskOK() {
		return
	}
	p.mu.Lock()
	todo := []*poolWant{}
	for repo, w := range p.wants {
		s := p.spares[repo]
		if p.busy[repo] {
			continue
		}
		if s == nil || (w.Agent != "" && s.proc == nil && s.AgentErr == "") {
			p.busy[repo] = true
			copy := *w
			todo = append(todo, &copy)
		}
	}
	p.mu.Unlock()
	var wg sync.WaitGroup
	for _, w := range todo {
		wg.Add(1)
		go func(w *poolWant) {
			defer wg.Done()
			defer func() {
				p.mu.Lock()
				delete(p.busy, w.Repo)
				p.mu.Unlock()
			}()
			p.fillOne(ctx, w)
		}(w)
	}
	wg.Wait()
}

func (p *Pool) fillOne(ctx context.Context, w *poolWant) {
	p.mu.Lock()
	s := p.spares[w.Repo]
	p.mu.Unlock()
	if s == nil {
		created, err := p.create(ctx, w)
		if err != nil {
			p.d.logf("pool: couldn't prepare a spare for %s: %v", w.Repo, err)
			return
		}
		s = created
		p.mu.Lock()
		if _, still := p.wants[w.Repo]; !still || p.spares[w.Repo] != nil {
			p.mu.Unlock()
			p.discard(s)
			return
		}
		p.spares[w.Repo] = s
		p.saveLocked()
		p.mu.Unlock()
		if w.Setup != "" {
			go p.runSetup(s, w.Setup)
		}
	}
	if w.Agent != "" {
		p.warmAgent(ctx, s, w)
	}
}

func (p *Pool) create(ctx context.Context, w *poolWant) (*spare, error) {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	name := "pool-" + hex.EncodeToString(b)
	path := p.sparePath(w.Repo, name)
	repo := p.repoPath(w.Repo)
	baseLine := `base=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'); [ -n "$base" ] || base=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)`
	if w.Base != "" {
		baseLine = "base=" + shq(w.Base)
	}
	script := strings.Join([]string{
		"repo=" + shq(repo),
		`git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || exit 3`,
		baseLine,
		`[ -n "$base" ] && [ "$base" != HEAD ] || exit 5`,
		`GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$repo" fetch --quiet origin "$base" >/dev/null 2>&1 || true`,
		`if git -C "$repo" rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}" >/dev/null; then start="origin/$base"; elif git -C "$repo" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then start="$base"; else exit 5; fi`,
		"mkdir -p " + shq(filepath.Dir(path)) + " || exit 6",
		`git -C "$repo" worktree add --quiet --detach ` + shq(path) + ` "$start" >&2 || exit 6`,
		`printf '@@base@@%s\n' "$base"`,
		`printf '@@commit@@%s\n' "$(git -C ` + shq(path) + ` rev-parse HEAD)"`,
	}, "\n")
	res, err := p.d.runScript(ctx, execParams{Script: script, TimeoutMs: 180000})
	if err != nil {
		return nil, err
	}
	if !res.OK {
		return nil, rpcErr(codeInternal, "worktree add exited %d: %s", *res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	base, commit := parseMarker(res.Stdout, "@@base@@"), parseMarker(res.Stdout, "@@commit@@")
	if !commitRE.MatchString(commit) {
		return nil, rpcErr(codeInternal, "spare has no commit")
	}
	setup := "none"
	if w.Setup != "" {
		setup = "pending"
	}
	return &spare{Name: name, Repo: w.Repo, Base: base, Path: path, Commit: commit, Setup: setup, CreatedAt: time.Now().UnixMilli()}, nil
}

func parseMarker(out, marker string) string {
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, marker) {
			return strings.TrimSpace(strings.TrimPrefix(line, marker))
		}
	}
	return ""
}

func (p *Pool) runSetup(s *spare, script string) {
	logPath := filepath.Join(p.dir(), s.Name+".setup.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer logFile.Close()
	p.d.chown(logPath)
	cmd := exec.Command(p.d.id.Shell, "-c", script)
	cmd.Env = p.d.env.Get(context.Background())
	cmd.Dir = s.Path
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	p.d.id.Prepare(cmd, true)
	cmd.WaitDelay = 2 * time.Second
	p.mu.Lock()
	if p.spares[s.Repo] != s {
		p.mu.Unlock()
		return
	}
	s.Setup = "running"
	s.setupCmd = cmd
	p.mu.Unlock()
	if err := cmd.Start(); err != nil {
		p.mu.Lock()
		s.Setup = "pending"
		s.setupCmd = nil
		p.mu.Unlock()
		return
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var werr error
	select {
	case werr = <-done:
	case <-time.After(20 * time.Minute):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		werr = <-done
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if s.setupCmd != cmd {
		return
	}
	s.setupCmd = nil
	if werr == nil {
		s.Setup = "done"
	} else {
		s.Setup = "failed"
	}
	if p.spares[s.Repo] == s {
		p.saveLocked()
	}
}

func (p *Pool) warmAgent(ctx context.Context, s *spare, w *poolWant) {
	spec, ok := p.d.agents.Get(w.Agent)
	if !ok {
		return
	}
	actx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	proc, err := p.d.spawnAgent(actx, spec, spawnOptions{Dir: s.Path, Env: p.d.env.Get(actx)})
	var state *acpSessionState
	if err == nil {
		state, err = proc.NewSession(actx, s.Path, p.d.mcpFor(w.MCP))
		if err != nil {
			proc.Kill()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.spares[s.Repo] != s {
		if err == nil {
			proc.Kill()
		}
		return
	}
	if err != nil {
		s.AgentErr = asRPCError(err).Message
		return
	}
	s.proc, s.state, s.Agent, s.AgentErr = proc, state, w.Agent, ""
	go func() {
		<-proc.exited
		p.mu.Lock()
		if s.proc == proc {
			s.proc, s.state, s.Agent = nil, nil, ""
		}
		p.mu.Unlock()
	}()
}

func (p *Pool) refresh(ctx context.Context) {
	p.mu.Lock()
	list := make([]*spare, 0, len(p.spares))
	for _, s := range p.spares {
		list = append(list, s)
	}
	p.mu.Unlock()
	for _, s := range list {
		script := strings.Join([]string{
			"repo=" + shq(p.repoPath(s.Repo)),
			"wt=" + shq(s.Path),
			"base=" + shq(s.Base),
			`GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$repo" fetch --quiet origin "$base" >/dev/null 2>&1 || exit 0`,
			`next=$(git -C "$repo" rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}") || exit 0`,
			`[ "$next" = "$(git -C "$wt" rev-parse HEAD)" ] && { printf '@@commit@@%s\n' "$next"; exit 0; }`,
			`[ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] || exit 0`,
			`git -C "$wt" checkout --quiet --detach "$next" >&2 || exit 0`,
			`printf '@@commit@@%s\n@@moved@@\n' "$next"`,
		}, "\n")
		res, err := p.d.runScript(ctx, execParams{Script: script, TimeoutMs: 90000})
		if err != nil || !res.OK {
			continue
		}
		commit := parseMarker(res.Stdout, "@@commit@@")
		if !commitRE.MatchString(commit) {
			continue
		}
		p.mu.Lock()
		if p.spares[s.Repo] == s && s.Commit != commit {
			s.Commit = commit
			if strings.Contains(res.Stdout, "@@moved@@") && s.Setup == "done" {
				s.Setup = "stale"
			}
			p.saveLocked()
		}
		p.mu.Unlock()
	}
}

type poolClaimParams struct {
	Repo   string                     `json:"repo"`
	Base   string                     `json:"base,omitempty"`
	Branch string                     `json:"branch"`
	Script string                     `json:"script,omitempty"`
	Agent  string                     `json:"agent,omitempty"`
	ChatID string                     `json:"chatId,omitempty"`
	Title  string                     `json:"title,omitempty"`
	Config map[string]json.RawMessage `json:"config,omitempty"`
	MCP    []json.RawMessage          `json:"mcpServers,omitempty"`
	Prompt *chatPromptParams          `json:"prompt,omitempty"`
}

type poolClaimResult struct {
	Claimed bool       `json:"claimed"`
	Name    string     `json:"name,omitempty"`
	Path    string     `json:"path,omitempty"`
	Base    string     `json:"base,omitempty"`
	Commit  string     `json:"commit,omitempty"`
	Setup   string     `json:"setup,omitempty"`
	Output  string     `json:"output,omitempty"`
	Chat    *ChatState `json:"chat,omitempty"`
	Warm    bool       `json:"warm"`
}

func (p *Pool) Claim(ctx context.Context, params poolClaimParams) (*poolClaimResult, error) {
	if !validRepo(params.Repo) || !validRef(params.Branch) {
		return nil, rpcErr(codeInvalidParams, "invalid repo or branch")
	}
	p.mu.Lock()
	s := p.spares[params.Repo]
	if s == nil || (params.Base != "" && params.Base != s.Base) {
		p.mu.Unlock()
		return &poolClaimResult{Claimed: false}, nil
	}
	delete(p.spares, params.Repo)
	if w := p.wants[params.Repo]; w != nil {
		w.UsedAt = time.Now().UnixMilli()
	}
	setupCmd := s.setupCmd
	s.setupCmd = nil
	p.saveLocked()
	p.mu.Unlock()
	if setupCmd != nil && setupCmd.Process != nil {
		_ = syscall.Kill(-setupCmd.Process.Pid, syscall.SIGKILL)
	}
	setup := s.Setup
	if setup != "done" && setup != "none" {
		setup = "pending"
	}
	lines := []string{
		"cd " + shq(s.Path) + " || exit 3",
		"git switch --quiet --no-track -c " + shq(params.Branch) + " >&2 || exit 4",
	}
	if params.Script != "" {
		lines = append(lines, params.Script)
	}
	lines = append(lines, "exit 0")
	res, err := p.d.runScript(ctx, execParams{Script: strings.Join(lines, "\n"), TimeoutMs: 30000})
	if err != nil || !res.OK {
		p.mu.Lock()
		if p.spares[params.Repo] == nil && (res == nil || res.ExitCode == nil || *res.ExitCode == 4) {
			p.spares[params.Repo] = s
			p.saveLocked()
		} else {
			go p.discard(s)
		}
		p.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return &poolClaimResult{Claimed: false, Output: strings.TrimSpace(res.Stderr)}, nil
	}
	out := &poolClaimResult{Claimed: true, Name: s.Name, Path: s.Path, Base: s.Base, Commit: s.Commit, Setup: setup, Output: res.Stdout}
	if params.Agent != "" && params.Agent == s.Agent && s.proc != nil && s.proc.Alive() {
		chat, err := p.d.createChat(context.Background(), chatCreateParams{
			ChatID: params.ChatID, Agent: params.Agent, Cwd: s.Path, Title: params.Title,
			MCP: params.MCP, Config: params.Config, Prompt: params.Prompt, warm: s.proc, warmState: s.state,
		})
		if err == nil {
			out.Chat = chat
			out.Warm = true
		}
	} else if s.proc != nil {
		s.proc.Kill()
	}
	p.poke()
	return out, nil
}

func (p *Pool) discard(s *spare) {
	if s.proc != nil {
		s.proc.Kill()
	}
	if s.setupCmd != nil && s.setupCmd.Process != nil {
		_ = syscall.Kill(-s.setupCmd.Process.Pid, syscall.SIGKILL)
	}
	script := strings.Join([]string{
		"repo=" + shq(p.repoPath(s.Repo)),
		`git -C "$repo" worktree remove --force ` + shq(s.Path) + ` >/dev/null 2>&1 || rm -rf -- ` + shq(s.Path),
		`git -C "$repo" worktree prune >/dev/null 2>&1 || true`,
	}, "\n")
	_, _ = p.d.runScript(context.Background(), execParams{Script: script, TimeoutMs: 60000})
	_ = os.Remove(filepath.Join(p.dir(), s.Name+".setup.log"))
}

func (p *Pool) Status() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	spares := []map[string]any{}
	for _, s := range p.spares {
		spares = append(spares, map[string]any{"repo": s.Repo, "name": s.Name, "base": s.Base, "commit": s.Commit, "setup": s.Setup, "agent": s.Agent, "warm": s.proc != nil, "agentError": s.AgentErr})
	}
	wants := []*poolWant{}
	for _, w := range p.wants {
		copy := *w
		copy.MCP = nil
		wants = append(wants, &copy)
	}
	return map[string]any{"spares": spares, "wants": wants, "disabled": p.off}
}

func (p *Pool) Shutdown() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.spares {
		if s.proc != nil {
			s.proc.Kill()
			s.proc, s.state, s.Agent = nil, nil, ""
		}
		if s.setupCmd != nil && s.setupCmd.Process != nil {
			_ = syscall.Kill(-s.setupCmd.Process.Pid, syscall.SIGKILL)
		}
	}
}
