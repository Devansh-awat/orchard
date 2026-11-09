//go:build !windows

package agentd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type harness struct {
	t      *testing.T
	d      *Daemon
	srv    *httptest.Server
	home   string
	token  string
	cancel context.CancelFunc
}

type client struct {
	t      *testing.T
	ws     *websocket.Conn
	peer   *peer
	mu     sync.Mutex
	events []Event
	notes  []rpcMessage
	cond   chan struct{}
}

func newHarness(t *testing.T, agents ...AgentSpec) *harness {
	t.Helper()
	home := t.TempDir()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("secret-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	agentsFile := filepath.Join(home, ".config", "orchard", "agents.json")
	_ = os.MkdirAll(filepath.Dir(agentsFile), 0o755)
	if len(agents) == 0 {
		agents = []AgentSpec{fakeSpec("fake", nil)}
	}
	disabled := []AgentSpec{{ID: "claude"}, {ID: "opencode"}, {ID: "fx"}, {ID: "codex"}}
	raw, _ := json.Marshal(append(disabled, agents...))
	_ = os.WriteFile(agentsFile, raw, 0o644)
	phase := filepath.Join(t.TempDir(), "phase")
	_ = os.WriteFile(phase, []byte("ready"), 0o644)
	d, err := New(Options{TokenFile: tokenFile, Home: home, PhaseFile: phase, AgentsFile: agentsFile, IdleAgent: time.Hour, InitDir: filepath.Join(home, "init")})
	if err != nil {
		t.Fatal(err)
	}
	d.pool.minFree = 0
	ctx, cancel := context.WithCancel(context.Background())
	srv := newTestServer(t, d)
	go d.pool.Run(ctx)
	h := &harness{t: t, d: d, srv: srv, home: home, token: "secret-token", cancel: cancel}
	t.Cleanup(cancel)
	return h
}

func newTestServer(t *testing.T, d *Daemon) *httptest.Server {
	srv := httptest.NewServer(d)
	t.Cleanup(func() {
		d.Shutdown()
		srv.Close()
	})
	return srv
}

func fakeSpec(id string, env map[string]string) AgentSpec {
	e := map[string]string{"AGENTD_FAKE_AGENT": "1"}
	for k, v := range env {
		e[k] = v
	}
	return AgentSpec{ID: id, Label: "Fake " + id, Command: []string{os.Args[0]}, Env: e}
}

func (h *harness) dial() *client {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(h.srv.URL, "http") + "/rpc"
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token}}})
	if err != nil {
		h.t.Fatal(err)
	}
	ws.SetReadLimit(64 << 20)
	c := &client{t: h.t, ws: ws, cond: make(chan struct{}, 1)}
	c.peer = newPeer(func(msg []byte) error {
		return ws.Write(context.Background(), websocket.MessageText, msg)
	})
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				c.peer.close(err)
				return
			}
			var msg rpcMessage
			if json.Unmarshal(data, &msg) == nil && msg.Method != "" && len(msg.ID) == 0 {
				c.mu.Lock()
				if msg.Method == "chat.event" {
					var ev Event
					_ = json.Unmarshal(msg.Params, &ev)
					c.events = append(c.events, ev)
				}
				c.notes = append(c.notes, msg)
				c.mu.Unlock()
				select {
				case c.cond <- struct{}{}:
				default:
				}
				continue
			}
			c.peer.dispatch(context.Background(), data, nil)
		}
	}()
	h.t.Cleanup(func() { _ = ws.CloseNow() })
	return c
}

func (c *client) call(method string, params any, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return c.peer.call(ctx, method, params, out)
}

func (c *client) must(method string, params any, out any) {
	c.t.Helper()
	if err := c.call(method, params, out); err != nil {
		c.t.Fatalf("%s: %v", method, err)
	}
}

func (c *client) waitFor(desc string, check func(events []Event, notes []rpcMessage) bool) {
	c.t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		c.mu.Lock()
		ok := check(append([]Event(nil), c.events...), append([]rpcMessage(nil), c.notes...))
		c.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-c.cond:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			c.mu.Lock()
			kinds := []string{}
			for _, e := range c.events {
				kinds = append(kinds, e.Kind)
			}
			c.mu.Unlock()
			c.t.Fatalf("timed out waiting for %s; events: %v", desc, kinds)
		}
	}
}

func kinds(events []Event, chatID string) []string {
	out := []string{}
	for _, e := range events {
		if e.ChatID == chatID {
			out = append(out, e.Kind)
		}
	}
	return out
}

func countKind(events []Event, chatID, kind string) int {
	n := 0
	for _, e := range events {
		if e.ChatID == chatID && e.Kind == kind {
			n++
		}
	}
	return n
}

func gitRepo(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	_ = os.MkdirAll(dir, 0o755)
	run("init", "-q", "-b", "main")
	_ = os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644)
	run("add", "-A")
	run("commit", "-q", "-m", "init")
}

func TestHealthIsPublicAndRPCNeedsTheToken(t *testing.T) {
	h := newHarness(t)
	res, err := http.Get(h.srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var health map[string]any
	_ = json.NewDecoder(res.Body).Decode(&health)
	res.Body.Close()
	if health["ok"] != true || health["phase"] != "ready" {
		t.Fatalf("health = %v", health)
	}
	for _, header := range []string{"", "Bearer nope", "Basic c2VjcmV0LXRva2Vu"} {
		req, _ := http.NewRequest("GET", h.srv.URL+"/rpc", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("auth %q got %d", header, res.StatusCode)
		}
	}
	c := h.dial()
	var init map[string]any
	c.must("initialize", nil, &init)
	if init["version"] != Version {
		t.Fatalf("initialize = %v", init)
	}
}

func TestExecScriptRunsWithStdinExitCodesTimeoutsAndBackgroundChildren(t *testing.T) {
	h := newHarness(t)
	c := h.dial()
	var res execResult
	c.must("exec.script", map[string]any{"script": "read x; echo out:$x; echo err >&2; pwd; exit 7", "stdin": base64.StdEncoding.EncodeToString([]byte("hi\n"))}, &res)
	if res.OK || res.ExitCode == nil || *res.ExitCode != 7 || !strings.Contains(res.Stdout, "out:hi") || !strings.Contains(res.Stderr, "err") || !strings.Contains(res.Stdout, h.home) {
		t.Fatalf("exec = %+v", res)
	}
	start := time.Now()
	c.must("exec.script", map[string]any{"script": "sleep 30 & echo started"}, &res)
	if !res.OK || time.Since(start) > 5*time.Second {
		t.Fatalf("a background child held the call open: %+v after %s", res, time.Since(start))
	}
	err := c.call("exec.script", map[string]any{"script": "sleep 10", "timeoutMs": 300}, &res)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("timeout err = %v", err)
	}
	c.must("exec.script", map[string]any{"script": "echo $FOO", "env": map[string]string{"FOO": "bar"}}, &res)
	if strings.TrimSpace(res.Stdout) != "bar" {
		t.Fatalf("env = %q", res.Stdout)
	}
	if err := c.call("nope.nope", nil, nil); err == nil {
		t.Fatal("unknown methods should fail")
	}
}

func createChat(t *testing.T, c *client, cwd string, extra map[string]any) ChatState {
	t.Helper()
	params := map[string]any{"agent": "fake", "cwd": cwd, "title": "test"}
	for k, v := range extra {
		params[k] = v
	}
	var st ChatState
	c.must("chat.create", params, &st)
	if st.AgentSessionID == "" {
		t.Fatalf("chat did not start: %+v", st)
	}
	var sub struct {
		Events []Event `json:"events"`
	}
	c.must("chat.subscribe", map[string]any{"chatId": st.ID, "since": 0}, &sub)
	return st
}

func TestAChatRunsATurnAndLogsEveryStepInOrder(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	if !strings.Contains(string(st.ConfigOptions), `"small"`) {
		t.Fatalf("config options = %s", st.ConfigOptions)
	}
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "edit notes.txt", "author": map[string]string{"id": "u1", "name": "Ada"}}, nil)
	c.waitFor("turn end", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 1 })
	var log struct {
		Events  []Event `json:"events"`
		LastSeq int64   `json:"lastSeq"`
	}
	c.must("chat.events", map[string]any{"chatId": st.ID, "since": 0}, &log)
	got := kinds(log.Events, st.ID)
	want := []string{"created", "session", "prompt", "checkpoint", "turn.start", "update", "update", "update", "turn.end"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("events = %v", got)
	}
	for i, e := range log.Events {
		if e.Seq != int64(i+1) {
			t.Fatalf("seq %d at %d", e.Seq, i)
		}
	}
	if log.Events[2].Author == nil || log.Events[2].Author.Name != "Ada" {
		t.Fatalf("prompt author = %+v", log.Events[2].Author)
	}
	c.waitFor("idle", func(_ []Event, notes []rpcMessage) bool {
		for _, n := range notes {
			if n.Method == "chat.activity" && strings.Contains(string(n.Params), `"idle"`) {
				return true
			}
		}
		return false
	})
	var later struct {
		Events []Event `json:"events"`
	}
	c.must("chat.events", map[string]any{"chatId": st.ID, "since": 5}, &later)
	if len(later.Events) != 4 || later.Events[0].Seq != 6 {
		t.Fatalf("since filter returned %d events", len(later.Events))
	}
	var list struct {
		Chats []ChatState `json:"chats"`
	}
	c.must("chat.list", map[string]any{"cwd": repo}, &list)
	if len(list.Chats) != 1 || list.Chats[0].Title != "test" {
		t.Fatalf("list = %+v", list.Chats)
	}
}

func TestPermissionRequestsWaitForAnAnswer(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "perm"}, nil)
	var reqID string
	c.waitFor("permission request", func(ev []Event, _ []rpcMessage) bool {
		for _, e := range ev {
			if e.ChatID == st.ID && e.Kind == "permission.request" {
				var p PendingRequest
				_ = json.Unmarshal(e.Data, &p)
				reqID = p.RequestID
				return true
			}
		}
		return false
	})
	var state ChatState
	c.must("chat.get", map[string]any{"chatId": st.ID}, &state)
	if state.Activity != "needs_input" || len(state.Permission) != 1 {
		t.Fatalf("state while waiting = %+v", state)
	}
	c.must("chat.permission", map[string]any{"chatId": st.ID, "requestId": reqID, "optionId": "allow", "author": map[string]string{"id": "u2"}}, nil)
	if err := c.call("chat.permission", map[string]any{"chatId": st.ID, "requestId": reqID, "optionId": "allow"}, nil); err == nil {
		t.Fatal("a second answer should be refused")
	}
	c.waitFor("turn end", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 1 })
	found := false
	c.mu.Lock()
	for _, e := range c.events {
		if e.Kind == "update" && strings.Contains(string(e.Data), `"t2"`) && strings.Contains(string(e.Data), `"completed"`) {
			found = true
		}
	}
	c.mu.Unlock()
	if !found {
		t.Fatal("the tool never completed after it was allowed")
	}
}

func TestACrashedAgentIsReportedAndTheNextPromptReattachesWithoutDuplicatingHistory(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "first"}, nil)
	c.waitFor("first turn", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 1 })
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "crash"}, nil)
	c.waitFor("crash", func(ev []Event, _ []rpcMessage) bool {
		return countKind(ev, st.ID, "agent.exit") == 1 && countKind(ev, st.ID, "turn.end") == 2
	})
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "again"}, nil)
	c.waitFor("third turn", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 3 })
	var log struct {
		Events []Event `json:"events"`
	}
	c.must("chat.events", map[string]any{"chatId": st.ID}, &log)
	for _, e := range log.Events {
		if strings.Contains(string(e.Data), "replayed") {
			t.Fatalf("history replay leaked into the log: %s", e.Data)
		}
	}
	if countKind(log.Events, st.ID, "session") != 1 {
		t.Fatal("the chat should have reattached to its session, not started a new one")
	}
}

func TestPromptsSentDuringATurnQueueAndCancelClearsThem(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "slow"}, nil)
	var queued map[string]any
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "next"}, &queued)
	if queued["queued"] != true {
		t.Fatalf("second prompt = %v", queued)
	}
	c.must("chat.cancel", map[string]any{"chatId": st.ID}, nil)
	c.waitFor("cancelled turn", func(ev []Event, _ []rpcMessage) bool {
		for _, e := range ev {
			if e.ChatID == st.ID && e.Kind == "turn.end" && strings.Contains(string(e.Data), "cancelled") {
				return true
			}
		}
		return false
	})
	time.Sleep(200 * time.Millisecond)
	c.mu.Lock()
	defer c.mu.Unlock()
	if countKind(c.events, st.ID, "turn.start") != 1 {
		t.Fatal("cancel should drop the queued prompt")
	}
}

func TestACancelThatBeatsThePromptToTheAgentStillCancelsIt(t *testing.T) {
	release := make(chan struct{})
	reached := make(chan struct{}, 1)
	beforePrompt = func() {
		reached <- struct{}{}
		<-release
	}
	t.Cleanup(func() { beforePrompt = func() {} })

	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "slow"}, nil)
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the turn never reached the agent")
	}
	c.must("chat.cancel", map[string]any{"chatId": st.ID}, nil)
	close(release)
	c.waitFor("cancelled turn", func(ev []Event, _ []rpcMessage) bool {
		for _, e := range ev {
			if e.ChatID == st.ID && e.Kind == "turn.end" && strings.Contains(string(e.Data), "cancelled") {
				return true
			}
		}
		return false
	})
}

func TestRevertRestoresTheWorktreeToACheckpoint(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	_ = os.WriteFile(filepath.Join(repo, "draft.txt"), []byte("mine\n"), 0o644)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "edit README.md"}, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "edit extra.txt"}, nil)
	c.waitFor("two turns", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 2 })
	var commit string
	c.mu.Lock()
	for _, e := range c.events {
		if e.ChatID == st.ID && e.Kind == "checkpoint" {
			var cp map[string]string
			_ = json.Unmarshal(e.Data, &cp)
			commit = cp["commit"]
			break
		}
	}
	c.mu.Unlock()
	if commit == "" {
		t.Fatal("no checkpoint was recorded")
	}
	c.must("chat.revert", map[string]any{"chatId": st.ID, "commit": commit}, nil)
	readme, _ := os.ReadFile(filepath.Join(repo, "README.md"))
	draft, _ := os.ReadFile(filepath.Join(repo, "draft.txt"))
	if string(readme) != "hello\n" || string(draft) != "mine\n" {
		t.Fatalf("after revert README=%q draft=%q", readme, draft)
	}
	if _, err := os.Stat(filepath.Join(repo, "extra.txt")); !os.IsNotExist(err) {
		t.Fatal("a file the agent created after the checkpoint survived the revert")
	}
	out, _ := exec.Command("git", "-C", repo, "diff", "--cached", "--name-only").Output()
	if strings.TrimSpace(string(out)) != "" {
		t.Fatalf("revert left staged changes: %s", out)
	}
	if err := c.call("chat.revert", map[string]any{"chatId": st.ID, "commit": "nothex"}, nil); err == nil {
		t.Fatal("a malformed checkpoint should be refused")
	}
	c.must("chat.delete", map[string]any{"chatId": st.ID}, nil)
	refs, _ := exec.Command("git", "-C", repo, "for-each-ref", "refs/orchard/").Output()
	if strings.TrimSpace(string(refs)) != "" {
		t.Fatalf("deleting the chat left checkpoint refs: %s", refs)
	}
	if err := c.call("chat.get", map[string]any{"chatId": st.ID}, nil); err == nil {
		t.Fatal("a deleted chat should be gone")
	}
}

func TestHugeToolOutputIsClampedInTheLog(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, nil)
	c.must("chat.prompt", map[string]any{"chatId": st.ID, "text": "big"}, nil)
	c.waitFor("turn", func(ev []Event, _ []rpcMessage) bool { return countKind(ev, st.ID, "turn.end") == 1 })
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if len(e.Data) > 100<<10 {
			t.Fatalf("event %s is %d bytes", e.Kind, len(e.Data))
		}
	}
}

func TestAnAgentThatRefusesToStartExplainsWhy(t *testing.T) {
	h := newHarness(t, fakeSpec("fake", nil), fakeSpec("broken", map[string]string{"FAKE_AGENT_FAIL_INIT": "fx needs access to Vercel AI Gateway"}))
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	var st ChatState
	c.must("chat.create", map[string]any{"agent": "broken", "cwd": repo}, &st)
	var log struct {
		Events []Event `json:"events"`
	}
	c.must("chat.events", map[string]any{"chatId": st.ID}, &log)
	last := log.Events[len(log.Events)-1]
	if last.Kind != "error" || !strings.Contains(string(last.Data), "Vercel AI Gateway") {
		t.Fatalf("last event = %s %s", last.Kind, last.Data)
	}
	h.d.catalog.Refresh(true)
	snap := h.d.catalog.Snapshot(false)
	byID := map[string]CatalogEntry{}
	for _, e := range snap["agents"].([]CatalogEntry) {
		byID[e.ID] = e
	}
	if !byID["fake"].Available || !strings.Contains(string(byID["fake"].ConfigOptions), "small") {
		t.Fatalf("fake = %+v", byID["fake"])
	}
	if byID["broken"].Available || !strings.Contains(byID["broken"].Error, "Vercel") {
		t.Fatalf("broken = %+v", byID["broken"])
	}
	if _, ok := byID["claude"]; ok {
		t.Fatal("an agent removed in agents.json is still listed")
	}
}

func TestConfigChangesAreSentToTheAgentAndRecorded(t *testing.T) {
	h := newHarness(t)
	repo := filepath.Join(h.home, "app")
	gitRepo(t, repo)
	c := h.dial()
	st := createChat(t, c, repo, map[string]any{"config": map[string]any{"model": "big"}})
	var state ChatState
	c.must("chat.get", map[string]any{"chatId": st.ID}, &state)
	if !strings.Contains(string(state.ConfigOptions), `"big"`) {
		t.Fatalf("config = %s", state.ConfigOptions)
	}
}

func TestThePoolHandsOutAPreparedWorktreeWithAWarmAgent(t *testing.T) {
	h := newHarness(t)
	origin := filepath.Join(t.TempDir(), "origin")
	gitRepo(t, origin)
	if out, err := exec.Command("git", "clone", "-q", origin, filepath.Join(h.home, "app")).CombinedOutput(); err != nil {
		t.Fatalf("clone: %v %s", err, out)
	}
	c := h.dial()
	c.must("pool.ensure", map[string]any{"repo": "app", "agent": "fake", "setup": "echo built > .setup-ran"}, nil)
	deadline := time.Now().Add(20 * time.Second)
	for {
		var status struct {
			Spares []map[string]any `json:"spares"`
		}
		c.must("pool.status", nil, &status)
		if len(status.Spares) == 1 && status.Spares[0]["warm"] == true && status.Spares[0]["setup"] == "done" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pool never filled: %+v", status)
		}
		time.Sleep(100 * time.Millisecond)
	}
	start := time.Now()
	var res poolClaimResult
	c.must("pool.claim", map[string]any{
		"repo": "app", "branch": "orchard/fix-a1b2", "agent": "fake", "chatId": "acp_claimed", "title": "Fix",
		"script": "echo hooked > .git-hook-ran",
		"prompt": map[string]any{"text": "hello", "author": map[string]string{"id": "u1"}},
	}, &res)
	elapsed := time.Since(start)
	if !res.Claimed || !res.Warm || res.Chat == nil || res.Chat.ID != "acp_claimed" || res.Setup != "done" || res.Base != "main" {
		t.Fatalf("claim = %+v", res)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("claiming a warm spare took %s", elapsed)
	}
	if !strings.HasPrefix(filepath.Base(res.Path), "pool-") {
		t.Fatalf("path = %s", res.Path)
	}
	branch, _ := exec.Command("git", "-C", res.Path, "branch", "--show-current").Output()
	if strings.TrimSpace(string(branch)) != "orchard/fix-a1b2" {
		t.Fatalf("branch = %q", branch)
	}
	if _, err := os.Stat(filepath.Join(res.Path, ".git-hook-ran")); err != nil {
		t.Fatal("the claim script did not run in the worktree")
	}
	c.must("chat.subscribe", map[string]any{"chatId": "acp_claimed"}, nil)
	c.waitFor("prompt turn on the warm agent", func(ev []Event, _ []rpcMessage) bool {
		return countKind(ev, "acp_claimed", "turn.end") == 1
	})
	var again poolClaimResult
	c.must("pool.claim", map[string]any{"repo": "app", "branch": "orchard/other"}, &again)
	if again.Claimed {
		deadline = time.Now().Add(20 * time.Second)
	}
	for !again.Claimed && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		c.must("pool.claim", map[string]any{"repo": "app", "branch": "orchard/other"}, &again)
	}
	if !again.Claimed || again.Path == res.Path {
		t.Fatalf("the pool did not replenish: %+v", again)
	}
	var none poolClaimResult
	c.must("pool.claim", map[string]any{"repo": "missing", "branch": "orchard/x"}, &none)
	if none.Claimed {
		t.Fatal("claimed a spare for a repo nobody asked for")
	}
	if err := c.call("pool.claim", map[string]any{"repo": "../x", "branch": "orchard/x"}, nil); err == nil {
		t.Fatal("a hostile repo name should be refused")
	}
}

func TestRefValidationRejectsInjection(t *testing.T) {
	for _, bad := range []string{"-D", "a..b", "a b", "$(id)", "a;b", "/x", "x/", "a@{1}", "x.lock", ".hidden"} {
		if validRef(bad) {
			t.Fatalf("%q should be invalid", bad)
		}
	}
	for _, good := range []string{"main", "orchard/fix-a1b2", "seb/wip/x_1"} {
		if !validRef(good) {
			t.Fatalf("%q should be valid", good)
		}
	}
	if !strings.Contains(shq("it's"), `'\''`) {
		t.Fatal("shq does not escape quotes")
	}
}

func TestTheOrchardMCPServerFromTheMachineConfigIsHandedToAgents(t *testing.T) {
	h := newHarness(t)
	_ = os.MkdirAll(filepath.Join(h.home, "init"), 0o755)
	_ = os.WriteFile(filepath.Join(h.home, "init", "opencode-config.json"), []byte(`{"plugin":["x"],"mcp":{"orchard":{"type":"remote","url":"https://orchard.example/mcp","headers":{"Authorization":"Bearer abc"},"enabled":true},"off":{"type":"remote","url":"https://x","enabled":false}}}`), 0o644)
	got := h.d.mcpFor(nil)
	if len(got) != 1 || !strings.Contains(string(got[0]), `"type":"http"`) || !strings.Contains(string(got[0]), `"Bearer abc"`) {
		t.Fatalf("mcp = %s", got)
	}
	explicit := []json.RawMessage{json.RawMessage(`{"name":"mine"}`)}
	if out := h.d.mcpFor(explicit); len(out) != 1 || string(out[0]) != `{"name":"mine"}` {
		t.Fatalf("explicit servers were replaced: %s", out)
	}
}
