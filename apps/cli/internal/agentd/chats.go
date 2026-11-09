//go:build !windows

package agentd

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var chatIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type Author struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

type Event struct {
	Seq    int64           `json:"seq"`
	TS     int64           `json:"ts"`
	ChatID string          `json:"chatId"`
	Kind   string          `json:"kind"`
	Author *Author         `json:"author,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

type ChatMeta struct {
	ID             string            `json:"id"`
	Agent          string            `json:"agent"`
	Cwd            string            `json:"cwd"`
	AgentSessionID string            `json:"agentSessionId,omitempty"`
	Title          string            `json:"title,omitempty"`
	MCP            []json.RawMessage `json:"mcpServers,omitempty"`
	ConfigOptions  json.RawMessage   `json:"configOptions,omitempty"`
	Models         json.RawMessage   `json:"models,omitempty"`
	Modes          json.RawMessage   `json:"modes,omitempty"`
	Commands       json.RawMessage   `json:"commands,omitempty"`
	CreatedAt      int64             `json:"createdAt"`
}

type ChatState struct {
	ChatMeta
	Activity   string           `json:"activity"`
	LastSeq    int64            `json:"lastSeq"`
	Running    bool             `json:"running"`
	Queued     int              `json:"queued"`
	Permission []PendingRequest `json:"permissions,omitempty"`
}

type PendingRequest struct {
	RequestID string          `json:"requestId"`
	ToolCall  json.RawMessage `json:"toolCall,omitempty"`
	Options   json.RawMessage `json:"options,omitempty"`
}

type queuedPrompt struct {
	blocks []json.RawMessage
}

type pendingPerm struct {
	req    PendingRequest
	answer chan json.RawMessage
}

type Chat struct {
	d      *Daemon
	dir    string
	mu     sync.Mutex
	sendMu sync.Mutex
	meta   ChatMeta
	seq    int64
	log    *os.File

	proc        *AgentProc
	starting    chan struct{}
	outstanding int
	queue       []queuedPrompt
	perms       map[string]*pendingPerm
	permSeq     int
	replaying   bool
	lastActive  time.Time
	activity    string
	deleted     bool
	cancelGen   int
	closing     bool
}

func newChatID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return "acp_" + hex.EncodeToString(b)
}

func (d *Daemon) chatsRoot() string {
	return filepath.Join(d.stateDir, "chats")
}

func (d *Daemon) chatByID(id string) (*Chat, error) {
	if !chatIDRE.MatchString(id) {
		return nil, rpcErr(codeInvalidParams, "invalid chat id")
	}
	d.chatsMu.Lock()
	defer d.chatsMu.Unlock()
	if c, ok := d.chats[id]; ok {
		return c, nil
	}
	dir := filepath.Join(d.chatsRoot(), id)
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, rpcErr(codeNotFound, "chat %s not found", id)
	}
	var meta ChatMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, rpcErr(codeInternal, "chat %s is corrupt", id)
	}
	c := &Chat{d: d, dir: dir, meta: meta, perms: map[string]*pendingPerm{}, activity: "idle", lastActive: time.Now()}
	c.seq = lastSeq(filepath.Join(dir, "events.jsonl"))
	if err := c.openLog(); err != nil {
		return nil, err
	}
	d.chats[id] = c
	return c, nil
}

func lastSeq(path string) int64 {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.Size() == 0 {
		return 0
	}
	const window = 256 << 10
	off := st.Size() - window
	if off < 0 {
		off = 0
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && len(buf) == 0 {
		return 0
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		var ev struct {
			Seq int64 `json:"seq"`
		}
		if json.Unmarshal([]byte(lines[i]), &ev) == nil && ev.Seq > 0 {
			return ev.Seq
		}
	}
	return 0
}

func (c *Chat) openLog() error {
	f, err := os.OpenFile(filepath.Join(c.dir, "events.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return rpcErr(codeInternal, "open chat log: %v", err)
	}
	c.log = f
	c.d.chown(filepath.Join(c.dir, "events.jsonl"))
	return nil
}

func (c *Chat) saveMetaLocked() {
	raw, err := json.MarshalIndent(c.meta, "", "  ")
	if err != nil {
		return
	}
	tmp := filepath.Join(c.dir, ".meta.json.tmp")
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(c.dir, "meta.json"))
		c.d.chown(filepath.Join(c.dir, "meta.json"))
	}
}

func (c *Chat) appendLocked(kind string, author *Author, data any) Event {
	c.seq++
	ev := Event{Seq: c.seq, TS: time.Now().UnixMilli(), ChatID: c.meta.ID, Kind: kind, Author: author}
	if data != nil {
		raw, err := json.Marshal(data)
		if err == nil {
			ev.Data = clampJSON(raw, maxEventString)
		}
	}
	if line, err := json.Marshal(ev); err == nil && c.log != nil {
		_, _ = c.log.Write(append(line, '\n'))
	}
	c.lastActive = time.Now()
	c.d.publish(ev)
	return ev
}

func (c *Chat) setActivityLocked() {
	next := "idle"
	if len(c.perms) > 0 {
		next = "needs_input"
	} else if c.outstanding > 0 || len(c.queue) > 0 || c.starting != nil {
		next = "working"
	}
	if next == c.activity {
		return
	}
	c.activity = next
	state := map[string]any{"chatId": c.meta.ID, "cwd": c.meta.Cwd, "activity": next}
	c.d.broadcast("chat.activity", state)
}

func (c *Chat) stateLocked() ChatState {
	perms := make([]PendingRequest, 0, len(c.perms))
	for _, p := range c.perms {
		perms = append(perms, p.req)
	}
	sort.Slice(perms, func(i, j int) bool { return perms[i].RequestID < perms[j].RequestID })
	return ChatState{
		ChatMeta:   c.meta,
		Activity:   c.activity,
		LastSeq:    c.seq,
		Running:    c.proc != nil && c.proc.Alive(),
		Queued:     len(c.queue),
		Permission: perms,
	}
}

type chatCreateParams struct {
	ChatID    string                     `json:"chatId,omitempty"`
	Agent     string                     `json:"agent"`
	Cwd       string                     `json:"cwd"`
	Title     string                     `json:"title,omitempty"`
	MCP       []json.RawMessage          `json:"mcpServers,omitempty"`
	Config    map[string]json.RawMessage `json:"config,omitempty"`
	Prompt    *chatPromptParams          `json:"prompt,omitempty"`
	warm      *AgentProc
	warmState *acpSessionState
}

func (d *Daemon) createChat(ctx context.Context, p chatCreateParams) (*ChatState, error) {
	spec, ok := d.agents.Get(p.Agent)
	if !ok {
		return nil, rpcErr(codeInvalidParams, "unknown agent %q", p.Agent)
	}
	if !filepath.IsAbs(p.Cwd) {
		return nil, rpcErr(codeInvalidParams, "cwd must be absolute")
	}
	if st, err := os.Stat(p.Cwd); err != nil || !st.IsDir() {
		return nil, rpcErr(codeInvalidParams, "cwd %s doesn't exist", p.Cwd)
	}
	id := p.ChatID
	if id == "" {
		id = newChatID()
	}
	if !chatIDRE.MatchString(id) {
		return nil, rpcErr(codeInvalidParams, "invalid chat id")
	}
	dir := filepath.Join(d.chatsRoot(), id)
	if _, err := os.Stat(filepath.Join(dir, "meta.json")); err == nil {
		c, err := d.chatByID(id)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		st := c.stateLocked()
		return &st, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, rpcErr(codeInternal, "create chat dir: %v", err)
	}
	d.chown(d.chatsRoot())
	d.chown(dir)
	c := &Chat{d: d, dir: dir, perms: map[string]*pendingPerm{}, activity: "idle", lastActive: time.Now()}
	c.meta = ChatMeta{ID: id, Agent: spec.ID, Cwd: p.Cwd, Title: p.Title, MCP: p.MCP, CreatedAt: time.Now().UnixMilli()}
	if err := c.openLog(); err != nil {
		return nil, err
	}
	d.chatsMu.Lock()
	d.chats[id] = c
	d.chatsMu.Unlock()
	c.mu.Lock()
	c.saveMetaLocked()
	c.appendLocked("created", nil, map[string]any{"agent": spec.ID, "cwd": p.Cwd, "title": p.Title})
	ready := make(chan struct{})
	c.starting = ready
	c.setActivityLocked()
	c.mu.Unlock()

	var startErr error
	func() {
		defer close(ready)
		proc, state, err := p.warm, p.warmState, error(nil)
		if proc == nil || !proc.Alive() {
			proc, err = d.spawnAgent(ctx, spec, c.spawnOptions())
			if err == nil {
				sctx, cancel := context.WithTimeout(ctx, 90*time.Second)
				state, err = proc.NewSession(sctx, p.Cwd, d.mcpFor(p.MCP))
				cancel()
				if err != nil {
					proc.Kill()
				}
			}
		} else {
			proc.onUpdate = c.onUpdate
			proc.onRequest = c.onRequest
		}
		if err != nil {
			startErr = err
			return
		}
		c.mu.Lock()
		c.proc = proc
		c.meta.AgentSessionID = state.SessionID
		c.applySessionStateLocked(state)
		c.saveMetaLocked()
		c.appendLocked("session", nil, c.sessionSnapshotLocked())
		c.mu.Unlock()
		go c.watch(proc)
		for key, value := range p.Config {
			if err := c.setConfig(ctx, key, value); err != nil {
				c.mu.Lock()
				c.appendLocked("error", nil, map[string]string{"message": fmt.Sprintf("couldn't set %s: %v", key, err)})
				c.mu.Unlock()
			}
		}
	}()
	c.mu.Lock()
	c.starting = nil
	if startErr != nil {
		c.appendLocked("error", nil, map[string]string{"message": asRPCError(startErr).Message, "fatal": "true"})
	}
	c.setActivityLocked()
	st := c.stateLocked()
	c.mu.Unlock()
	if startErr != nil {
		return &st, nil
	}
	if p.Prompt != nil {
		p.Prompt.ChatID = id
		if _, err := d.prompt(ctx, *p.Prompt); err != nil {
			return &st, nil
		}
		c.mu.Lock()
		st = c.stateLocked()
		c.mu.Unlock()
	}
	return &st, nil
}

func (c *Chat) spawnOptions() spawnOptions {
	return spawnOptions{Dir: c.meta.Cwd, Env: c.d.env.Get(context.Background()), OnUpdate: c.onUpdate, OnRequest: c.onRequest}
}

func (c *Chat) applySessionStateLocked(state *acpSessionState) {
	if len(state.ConfigOptions) > 0 && string(state.ConfigOptions) != "null" {
		c.meta.ConfigOptions = state.ConfigOptions
	}
	if len(state.Models) > 0 && string(state.Models) != "null" {
		c.meta.Models = state.Models
	}
	if len(state.Modes) > 0 && string(state.Modes) != "null" {
		c.meta.Modes = state.Modes
	}
}

func (c *Chat) sessionSnapshotLocked() map[string]any {
	return map[string]any{
		"agentSessionId": c.meta.AgentSessionID,
		"configOptions":  c.meta.ConfigOptions,
		"models":         c.meta.Models,
		"modes":          c.meta.Modes,
	}
}

func (c *Chat) watch(proc *AgentProc) {
	<-proc.exited
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proc != proc {
		return
	}
	c.proc = nil
	if c.closing || c.deleted {
		return
	}
	detail := proc.failureDetail(errors.New(proc.exitReason()))
	c.appendLocked("agent.exit", nil, map[string]string{"detail": detail})
	for id, p := range c.perms {
		close(p.answer)
		delete(c.perms, id)
	}
	c.setActivityLocked()
}

func (c *Chat) onUpdate(sessionID string, update json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.replaying || c.deleted {
		return
	}
	var head struct {
		Kind          string          `json:"sessionUpdate"`
		Title         string          `json:"title"`
		ConfigOptions json.RawMessage `json:"configOptions"`
		Commands      json.RawMessage `json:"availableCommands"`
	}
	_ = json.Unmarshal(update, &head)
	switch head.Kind {
	case "session_info_update":
		if head.Title != "" {
			c.meta.Title = head.Title
			c.saveMetaLocked()
		}
	case "config_option_update":
		if len(head.ConfigOptions) > 0 {
			c.meta.ConfigOptions = head.ConfigOptions
			c.saveMetaLocked()
		}
	case "available_commands_update":
		c.meta.Commands = head.Commands
		c.saveMetaLocked()
	}
	c.appendLocked("update", nil, update)
}

func (c *Chat) onRequest(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method != "session/request_permission" {
		return nil, rpcErr(codeMethodNotFound, "method %s not supported", method)
	}
	var req struct {
		ToolCall json.RawMessage `json:"toolCall"`
		Options  json.RawMessage `json:"options"`
	}
	_ = json.Unmarshal(params, &req)
	c.mu.Lock()
	c.permSeq++
	id := fmt.Sprintf("perm_%d_%d", c.seq+1, c.permSeq)
	p := &pendingPerm{req: PendingRequest{RequestID: id, ToolCall: req.ToolCall, Options: req.Options}, answer: make(chan json.RawMessage, 1)}
	c.perms[id] = p
	c.appendLocked("permission.request", nil, p.req)
	c.setActivityLocked()
	c.mu.Unlock()
	cancelled := json.RawMessage(`{"outcome":{"outcome":"cancelled"}}`)
	select {
	case answer, ok := <-p.answer:
		if !ok {
			return cancelled, nil
		}
		return answer, nil
	case <-ctx.Done():
		return cancelled, nil
	}
}

type permissionParams struct {
	ChatID    string  `json:"chatId"`
	RequestID string  `json:"requestId"`
	OptionID  string  `json:"optionId,omitempty"`
	Cancel    bool    `json:"cancel,omitempty"`
	Author    *Author `json:"author,omitempty"`
}

func (d *Daemon) answerPermission(p permissionParams) (any, error) {
	c, err := d.chatByID(p.ChatID)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	pending, ok := c.perms[p.RequestID]
	if !ok {
		return nil, rpcErr(codeNotFound, "that request was already answered")
	}
	delete(c.perms, p.RequestID)
	var outcome any = map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}
	if !p.Cancel && p.OptionID != "" {
		outcome = map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": p.OptionID}}
	}
	raw, _ := json.Marshal(outcome)
	pending.answer <- raw
	c.appendLocked("permission.resolve", p.Author, map[string]any{"requestId": p.RequestID, "optionId": p.OptionID, "cancelled": p.Cancel || p.OptionID == ""})
	c.setActivityLocked()
	return map[string]bool{"ok": true}, nil
}

type chatPromptParams struct {
	ChatID    string            `json:"chatId"`
	MessageID string            `json:"messageId,omitempty"`
	Text      string            `json:"text,omitempty"`
	Blocks    []json.RawMessage `json:"blocks,omitempty"`
	Author    *Author           `json:"author,omitempty"`
	Steer     bool              `json:"steer,omitempty"`
}

func (d *Daemon) prompt(ctx context.Context, p chatPromptParams) (any, error) {
	c, err := d.chatByID(p.ChatID)
	if err != nil {
		return nil, err
	}
	blocks := p.Blocks
	if len(blocks) == 0 {
		if strings.TrimSpace(p.Text) == "" {
			return nil, rpcErr(codeInvalidParams, "text is required")
		}
		raw, _ := json.Marshal(map[string]string{"type": "text", "text": p.Text})
		blocks = []json.RawMessage{raw}
	}
	if p.MessageID == "" {
		p.MessageID = "msg_" + strings.TrimPrefix(newChatID(), "acp_")
	}
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return nil, rpcErr(codeNotFound, "chat was deleted")
	}
	ev := c.appendLocked("prompt", p.Author, map[string]any{"messageId": p.MessageID, "prompt": blocks})
	busy := c.outstanding > 0 || c.starting != nil
	proc := c.proc
	concurrent := busy && proc != nil && (proc.QueuesPrompts() || (p.Steer && proc.Steerable()))
	if busy && !concurrent {
		c.queue = append(c.queue, queuedPrompt{blocks: blocks})
		c.setActivityLocked()
		c.mu.Unlock()
		return map[string]any{"messageId": p.MessageID, "seq": ev.Seq, "queued": true}, nil
	}
	c.outstanding++
	c.setActivityLocked()
	c.mu.Unlock()
	meta := map[string]any{}
	if concurrent && p.Steer && proc.Steerable() {
		meta["fx"] = map[string]bool{"steer": true}
	}
	gen := c.cancelGen
	go c.runTurn(blocks, meta, !concurrent, gen)
	return map[string]any{"messageId": p.MessageID, "seq": ev.Seq, "queued": false}, nil
}

func (c *Chat) ensureProc(ctx context.Context) (*AgentProc, error) {
	c.mu.Lock()
	if c.proc != nil && c.proc.Alive() {
		proc := c.proc
		c.mu.Unlock()
		return proc, nil
	}
	if wait := c.starting; wait != nil {
		c.mu.Unlock()
		<-wait
		return c.ensureProc(ctx)
	}
	ready := make(chan struct{})
	c.starting = ready
	meta := c.meta
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.starting = nil
		c.mu.Unlock()
		close(ready)
	}()
	spec, ok := c.d.agents.Get(meta.Agent)
	if !ok {
		return nil, rpcErr(codeUnavailable, "agent %s is no longer configured", meta.Agent)
	}
	proc, err := c.d.spawnAgent(ctx, spec, c.spawnOptions())
	if err != nil {
		return nil, err
	}
	sctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	var state *acpSessionState
	if meta.AgentSessionID != "" {
		c.mu.Lock()
		c.replaying = true
		c.mu.Unlock()
		state, _, err = proc.Reattach(sctx, meta.AgentSessionID, meta.Cwd, c.d.mcpFor(meta.MCP))
		c.mu.Lock()
		c.replaying = false
		c.mu.Unlock()
	}
	fresh := false
	if meta.AgentSessionID == "" || err != nil {
		state, err = proc.NewSession(sctx, meta.Cwd, c.d.mcpFor(meta.MCP))
		fresh = true
	}
	if err != nil {
		proc.Kill()
		return nil, err
	}
	c.mu.Lock()
	c.proc = proc
	c.meta.AgentSessionID = state.SessionID
	c.applySessionStateLocked(state)
	c.saveMetaLocked()
	if fresh {
		c.appendLocked("session", nil, c.sessionSnapshotLocked())
	}
	c.mu.Unlock()
	go c.watch(proc)
	return proc, nil
}

var beforePrompt = func() {}

func (c *Chat) runTurn(blocks []json.RawMessage, meta map[string]any, ownsTurn bool, gen int) {
	ctx := context.Background()
	finish := func(kind string, data any) {
		c.mu.Lock()
		c.appendLocked(kind, nil, data)
		c.outstanding--
		var next *queuedPrompt
		if ownsTurn && c.outstanding == 0 && len(c.queue) > 0 && !c.deleted {
			q := c.queue[0]
			c.queue = c.queue[1:]
			next = &q
			c.outstanding++
		}
		nextGen := c.cancelGen
		c.setActivityLocked()
		c.mu.Unlock()
		if next != nil {
			go c.runTurn(next.blocks, nil, true, nextGen)
		}
	}
	proc, err := c.ensureProc(ctx)
	if err != nil {
		c.mu.Lock()
		c.appendLocked("error", nil, map[string]string{"message": asRPCError(err).Message})
		c.mu.Unlock()
		finish("turn.end", map[string]string{"stopReason": "error"})
		return
	}
	if ownsTurn {
		cp := c.d.checkpoint(ctx, c.meta.Cwd, c.meta.ID, c.nextSeq())
		c.mu.Lock()
		if cp != "" {
			c.appendLocked("checkpoint", nil, map[string]string{"commit": cp})
		}
		c.appendLocked("turn.start", nil, nil)
		c.mu.Unlock()
	}
	beforePrompt()
	c.sendMu.Lock()
	c.mu.Lock()
	sessionID := c.meta.AgentSessionID
	cancelled := c.cancelGen != gen || c.deleted
	c.mu.Unlock()
	if cancelled {
		c.sendMu.Unlock()
		finish("turn.end", map[string]string{"stopReason": "cancelled"})
		return
	}
	unlocked := false
	release := func() {
		if !unlocked {
			unlocked = true
			c.sendMu.Unlock()
		}
	}
	stop, err := proc.Prompt(ctx, sessionID, blocks, meta, release)
	release()
	if err != nil {
		c.mu.Lock()
		if !c.deleted {
			c.appendLocked("error", nil, map[string]string{"message": asRPCError(err).Message})
		}
		c.mu.Unlock()
		finish("turn.end", map[string]string{"stopReason": "error"})
		return
	}
	if ownsTurn {
		finish("turn.end", map[string]string{"stopReason": stop})
	} else {
		finish("prompt.done", map[string]string{"stopReason": stop})
	}
}

func (c *Chat) nextSeq() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seq + 1
}

func (d *Daemon) cancel(chatID string, author *Author) (any, error) {
	c, err := d.chatByID(chatID)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.queue = nil
	c.cancelGen++
	for id, p := range c.perms {
		close(p.answer)
		delete(c.perms, id)
	}
	proc, sessionID := c.proc, c.meta.AgentSessionID
	c.appendLocked("cancel", author, nil)
	c.setActivityLocked()
	c.mu.Unlock()
	if proc != nil {
		c.sendMu.Lock()
		_ = proc.Cancel(sessionID)
		c.sendMu.Unlock()
	}
	return map[string]bool{"ok": true}, nil
}

func (c *Chat) setConfig(ctx context.Context, configID string, value json.RawMessage) error {
	proc, err := c.ensureProc(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	sessionID := c.meta.AgentSessionID
	c.mu.Unlock()
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	opts, err := proc.SetConfig(cctx, sessionID, configID, value)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if len(opts) > 0 && string(opts) != "null" {
		c.meta.ConfigOptions = opts
	} else {
		c.meta.ConfigOptions = patchConfig(c.meta.ConfigOptions, configID, value)
	}
	c.saveMetaLocked()
	c.appendLocked("config", nil, map[string]any{"configId": configID, "value": value, "configOptions": c.meta.ConfigOptions})
	c.mu.Unlock()
	return nil
}

func patchConfig(options json.RawMessage, id string, value json.RawMessage) json.RawMessage {
	var list []map[string]json.RawMessage
	if json.Unmarshal(options, &list) != nil {
		return options
	}
	idRaw, _ := json.Marshal(id)
	for _, opt := range list {
		if string(opt["id"]) == string(idRaw) {
			opt["currentValue"] = value
		}
	}
	out, err := json.Marshal(list)
	if err != nil {
		return options
	}
	return out
}

func (d *Daemon) readEvents(chatID string, since int64, limit int) ([]Event, int64, error) {
	c, err := d.chatByID(chatID)
	if err != nil {
		return nil, 0, err
	}
	c.mu.Lock()
	last := c.seq
	c.mu.Unlock()
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	f, err := os.Open(filepath.Join(c.dir, "events.jsonl"))
	if err != nil {
		return []Event{}, last, nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	out := []Event{}
	for sc.Scan() {
		var ev Event
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev.Seq <= since || ev.Seq > last {
			continue
		}
		out = append(out, ev)
		if len(out) >= limit {
			break
		}
	}
	return out, last, nil
}

func (d *Daemon) closeChat(chatID string, remove bool) error {
	c, err := d.chatByID(chatID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.closing = true
	if remove {
		c.deleted = true
	}
	proc := c.proc
	c.proc = nil
	sessionID := c.meta.AgentSessionID
	for id, p := range c.perms {
		close(p.answer)
		delete(c.perms, id)
	}
	c.queue = nil
	c.setActivityLocked()
	c.mu.Unlock()
	if proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		proc.CloseSession(ctx, sessionID)
		cancel()
		proc.Kill()
	}
	if remove {
		d.chatsMu.Lock()
		delete(d.chats, chatID)
		d.chatsMu.Unlock()
		c.mu.Lock()
		if c.log != nil {
			_ = c.log.Close()
		}
		c.mu.Unlock()
		_ = os.RemoveAll(c.dir)
		_, _ = d.runScript(context.Background(), execParams{Script: deleteCheckpointsScript(chatID), Cwd: c.meta.Cwd, TimeoutMs: 15000})
		return nil
	}
	c.mu.Lock()
	c.closing = false
	c.mu.Unlock()
	return nil
}

func (d *Daemon) listChats(cwd string) []ChatState {
	entries, _ := os.ReadDir(d.chatsRoot())
	out := []ChatState{}
	for _, e := range entries {
		if !e.IsDir() || !chatIDRE.MatchString(e.Name()) {
			continue
		}
		c, err := d.chatByID(e.Name())
		if err != nil {
			continue
		}
		c.mu.Lock()
		if cwd == "" || c.meta.Cwd == cwd {
			out = append(out, c.stateLocked())
		}
		c.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

func (d *Daemon) reapIdle(maxIdle time.Duration) {
	d.chatsMu.Lock()
	chats := make([]*Chat, 0, len(d.chats))
	for _, c := range d.chats {
		chats = append(chats, c)
	}
	d.chatsMu.Unlock()
	for _, c := range chats {
		c.mu.Lock()
		idle := c.proc != nil && c.outstanding == 0 && len(c.perms) == 0 && len(c.queue) == 0 && c.starting == nil && time.Since(c.lastActive) > maxIdle
		c.mu.Unlock()
		if idle {
			_ = d.closeChat(c.meta.ID, false)
		}
	}
}

const maxEventString = 48 << 10

func clampJSON(raw json.RawMessage, max int) json.RawMessage {
	if len(raw) <= max {
		return raw
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return raw
	}
	out, err := json.Marshal(clampValue(v, max))
	if err != nil {
		return raw
	}
	return out
}

func clampValue(v any, max int) any {
	switch t := v.(type) {
	case string:
		if len(t) > max {
			cut := max
			for cut > 0 && (t[cut]&0xC0) == 0x80 {
				cut--
			}
			return t[:cut] + "\n…[truncated]"
		}
		return t
	case []any:
		for i := range t {
			t[i] = clampValue(t[i], max)
		}
		return t
	case map[string]any:
		for k, val := range t {
			t[k] = clampValue(val, max)
		}
		return t
	}
	return v
}
