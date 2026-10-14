//go:build !windows

package agentd

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const Version = "1"

type Options struct {
	TokenFile  string
	User       string
	StateDir   string
	Home       string
	PhaseFile  string
	AgentsFile string
	InitDir    string
	IdleAgent  time.Duration
	Logf       func(format string, args ...any)
}

type Daemon struct {
	opts     Options
	id       *Identity
	env      *LoginEnv
	stateDir string
	agents   *Registry
	catalog  *Catalog
	pool     *Pool

	chatsMu sync.Mutex
	chats   map[string]*Chat

	connsMu sync.Mutex
	conns   map[*conn]struct{}

	methods map[string]Handler
	started time.Time
}

type conn struct {
	d       *Daemon
	peer    *peer
	out     chan []byte
	mu      sync.Mutex
	subs    map[string]bool
	dropped bool
	cancel  context.CancelFunc
}

func New(opts Options) (*Daemon, error) {
	id, err := ResolveIdentity(opts.User)
	if err != nil {
		return nil, err
	}
	if opts.Home != "" {
		id.Home = opts.Home
	}
	if opts.StateDir == "" {
		opts.StateDir = filepath.Join(id.Home, ".orchard")
	}
	if opts.IdleAgent <= 0 {
		opts.IdleAgent = 15 * time.Minute
	}
	if opts.AgentsFile == "" {
		opts.AgentsFile = filepath.Join(id.Home, ".config", "orchard", "agents.json")
	}
	d := &Daemon{
		opts:     opts,
		id:       id,
		env:      NewLoginEnv(id),
		stateDir: opts.StateDir,
		chats:    map[string]*Chat{},
		conns:    map[*conn]struct{}{},
		started:  time.Now(),
	}
	if err := os.MkdirAll(filepath.Join(d.stateDir, "chats"), 0o700); err != nil {
		return nil, err
	}
	d.chown(d.stateDir)
	d.chown(filepath.Join(d.stateDir, "chats"))
	d.agents = NewRegistry(opts.AgentsFile)
	d.catalog = NewCatalog(d)
	d.pool = NewPool(d)
	d.registerMethods()
	return d, nil
}

func (d *Daemon) logf(format string, args ...any) {
	if d.opts.Logf != nil {
		d.opts.Logf(format, args...)
	}
}

func (d *Daemon) chown(path string) {
	if d.id.cred == nil {
		return
	}
	_ = os.Lchown(path, int(d.id.cred.Uid), int(d.id.cred.Gid))
}

func (d *Daemon) authorized(r *http.Request) bool {
	if d.opts.TokenFile == "" {
		return false
	}
	data, err := os.ReadFile(d.opts.TokenFile)
	if err != nil {
		return false
	}
	want := strings.TrimSpace(string(data))
	if want == "" {
		return false
	}
	scheme, got, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(strings.TrimSpace(got)), []byte(want)) == 1
}

func (d *Daemon) phase() string {
	if d.opts.PhaseFile == "" {
		return ""
	}
	data, err := os.ReadFile(d.opts.PhaseFile)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (d *Daemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/health":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": Version, "phase": d.phase()})
	case "/rpc":
		if !d.authorized(r) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionContextTakeover})
		if err != nil {
			return
		}
		ws.SetReadLimit(64 << 20)
		d.serveConn(r.Context(), ws)
	default:
		http.NotFound(w, r)
	}
}

func (d *Daemon) serveConn(parent context.Context, ws *websocket.Conn) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c := &conn{d: d, out: make(chan []byte, 8192), subs: map[string]bool{}, cancel: cancel}
	c.peer = newPeer(func(msg []byte) error {
		select {
		case c.out <- msg:
			return nil
		default:
			c.drop()
			return errors.New("connection is too slow")
		}
	})
	d.connsMu.Lock()
	d.conns[c] = struct{}{}
	d.connsMu.Unlock()
	defer func() {
		d.connsMu.Lock()
		delete(d.conns, c)
		d.connsMu.Unlock()
		c.peer.close(errors.New("closed"))
	}()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.out:
				wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
				err := ws.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			_ = ws.CloseNow()
			return
		}
		c.peer.dispatch(ctx, data, func(ctx context.Context, method string, params json.RawMessage) (any, error) {
			return d.handle(ctx, c, method, params)
		})
	}
}

func (c *conn) drop() {
	c.mu.Lock()
	if c.dropped {
		c.mu.Unlock()
		return
	}
	c.dropped = true
	c.mu.Unlock()
	c.cancel()
}

func (d *Daemon) publish(ev Event) {
	d.connsMu.Lock()
	targets := make([]*conn, 0, len(d.conns))
	for c := range d.conns {
		c.mu.Lock()
		if c.subs[ev.ChatID] || c.subs["*"] {
			targets = append(targets, c)
		}
		c.mu.Unlock()
	}
	d.connsMu.Unlock()
	for _, c := range targets {
		_ = c.peer.notify("chat.event", ev)
	}
}

func (d *Daemon) broadcast(method string, params any) {
	d.connsMu.Lock()
	targets := make([]*conn, 0, len(d.conns))
	for c := range d.conns {
		targets = append(targets, c)
	}
	d.connsMu.Unlock()
	for _, c := range targets {
		_ = c.peer.notify(method, params)
	}
}

func (d *Daemon) handle(ctx context.Context, c *conn, method string, params json.RawMessage) (any, error) {
	switch method {
	case "chat.subscribe":
		p, err := decode[struct {
			ChatID string `json:"chatId"`
			Since  int64  `json:"since"`
		}](params)
		if err != nil {
			return nil, err
		}
		if p.ChatID != "*" {
			if _, err := d.chatByID(p.ChatID); err != nil {
				return nil, err
			}
		}
		c.mu.Lock()
		c.subs[p.ChatID] = true
		c.mu.Unlock()
		if p.ChatID == "*" {
			return map[string]bool{"ok": true}, nil
		}
		events, last, err := d.readEvents(p.ChatID, p.Since, 0)
		if err != nil {
			return nil, err
		}
		return map[string]any{"events": events, "lastSeq": last}, nil
	case "chat.unsubscribe":
		p, err := decode[struct {
			ChatID string `json:"chatId"`
		}](params)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		delete(c.subs, p.ChatID)
		c.mu.Unlock()
		return map[string]bool{"ok": true}, nil
	}
	h, ok := d.methods[method]
	if !ok {
		return nil, rpcErr(codeMethodNotFound, "method %s not found", method)
	}
	return h(ctx, params)
}

func (d *Daemon) registerMethods() {
	d.methods = map[string]Handler{
		"initialize": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return map[string]any{"version": Version, "user": d.id.Name, "home": d.id.Home, "phase": d.phase(), "startedAt": d.started.UnixMilli()}, nil
		},
		"ping": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return map[string]bool{"ok": true}, nil
		},
		"boot.phase": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return map[string]string{"phase": d.phase()}, nil
		},
		"exec.script": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[execParams](raw)
			if err != nil {
				return nil, err
			}
			return d.runScript(ctx, p)
		},
		"agent.catalog": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, _ := decode[struct {
				Refresh bool `json:"refresh"`
			}](raw)
			return d.catalog.Snapshot(p.Refresh), nil
		},
		"chat.create": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[chatCreateParams](raw)
			if err != nil {
				return nil, err
			}
			return d.createChat(context.Background(), p)
		},
		"chat.prompt": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[chatPromptParams](raw)
			if err != nil {
				return nil, err
			}
			return d.prompt(ctx, p)
		},
		"chat.cancel": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string  `json:"chatId"`
				Author *Author `json:"author"`
			}](raw)
			if err != nil {
				return nil, err
			}
			return d.cancel(p.ChatID, p.Author)
		},
		"chat.permission": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[permissionParams](raw)
			if err != nil {
				return nil, err
			}
			return d.answerPermission(p)
		},
		"chat.config": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID   string          `json:"chatId"`
				ConfigID string          `json:"configId"`
				Value    json.RawMessage `json:"value"`
			}](raw)
			if err != nil {
				return nil, err
			}
			c, err := d.chatByID(p.ChatID)
			if err != nil {
				return nil, err
			}
			if err := c.setConfig(ctx, p.ConfigID, p.Value); err != nil {
				return nil, err
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.stateLocked(), nil
		},
		"chat.events": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string `json:"chatId"`
				Since  int64  `json:"since"`
				Limit  int    `json:"limit"`
			}](raw)
			if err != nil {
				return nil, err
			}
			events, last, err := d.readEvents(p.ChatID, p.Since, p.Limit)
			if err != nil {
				return nil, err
			}
			return map[string]any{"events": events, "lastSeq": last}, nil
		},
		"chat.get": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string `json:"chatId"`
			}](raw)
			if err != nil {
				return nil, err
			}
			c, err := d.chatByID(p.ChatID)
			if err != nil {
				return nil, err
			}
			c.mu.Lock()
			defer c.mu.Unlock()
			return c.stateLocked(), nil
		},
		"chat.list": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, _ := decode[struct {
				Cwd string `json:"cwd"`
			}](raw)
			return map[string]any{"chats": d.listChats(p.Cwd)}, nil
		},
		"chat.close": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string `json:"chatId"`
			}](raw)
			if err != nil {
				return nil, err
			}
			return map[string]bool{"ok": true}, d.closeChat(p.ChatID, false)
		},
		"chat.delete": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string `json:"chatId"`
			}](raw)
			if err != nil {
				return nil, err
			}
			return map[string]bool{"ok": true}, d.closeChat(p.ChatID, true)
		},
		"chat.revert": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[struct {
				ChatID string  `json:"chatId"`
				Commit string  `json:"commit"`
				Author *Author `json:"author"`
			}](raw)
			if err != nil {
				return nil, err
			}
			return d.revert(ctx, p.ChatID, p.Commit, p.Author)
		},
		"activity.busy": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return map[string]bool{"busy": d.anyBusy()}, nil
		},
		"activity.list": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, _ := decode[struct {
				Cwd string `json:"cwd"`
			}](raw)
			out := map[string]string{}
			for _, st := range d.listChats(p.Cwd) {
				out[st.ID] = st.Activity
			}
			return map[string]any{"activity": out}, nil
		},
		"pool.claim": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[poolClaimParams](raw)
			if err != nil {
				return nil, err
			}
			return d.pool.Claim(ctx, p)
		},
		"pool.ensure": func(ctx context.Context, raw json.RawMessage) (any, error) {
			p, err := decode[poolEnsureParams](raw)
			if err != nil {
				return nil, err
			}
			return d.pool.Ensure(p)
		},
		"pool.status": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return d.pool.Status(), nil
		},
	}
}

func (d *Daemon) anyBusy() bool {
	d.chatsMu.Lock()
	defer d.chatsMu.Unlock()
	for _, c := range d.chats {
		c.mu.Lock()
		busy := c.outstanding > 0 || len(c.perms) > 0 || len(c.queue) > 0
		c.mu.Unlock()
		if busy {
			return true
		}
	}
	return false
}

func (d *Daemon) Serve(ctx context.Context, ln net.Listener) error {
	srv := &http.Server{Handler: d, ReadHeaderTimeout: 15 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	go d.catalog.Refresh(false)
	go d.pool.Run(ctx)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.reapIdle(d.opts.IdleAgent)
			}
		}
	}()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
		d.Shutdown()
	}()
	err := srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (d *Daemon) ListenAndServe(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return d.Serve(ctx, ln)
}

func (d *Daemon) Shutdown() {
	d.chatsMu.Lock()
	ids := make([]string, 0, len(d.chats))
	for id := range d.chats {
		ids = append(ids, id)
	}
	d.chatsMu.Unlock()
	for _, id := range ids {
		_ = d.closeChat(id, false)
	}
	d.pool.Shutdown()
}
