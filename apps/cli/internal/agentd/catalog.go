//go:build !windows

package agentd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

var defaultAgents = []AgentSpec{
	{ID: "claude", Label: "Claude Code", Command: []string{"claude-agent-acp"}},
	{ID: "opencode", Label: "opencode", Command: []string{"opencode", "acp"}},
	{ID: "fx", Label: "fx", Command: []string{"fx", "acp"}},
	{ID: "codex", Label: "Codex", Command: []string{"codex-acp"}},
}

type Registry struct {
	path string
	mu   sync.Mutex
	at   time.Time
	list []AgentSpec
}

func NewRegistry(path string) *Registry {
	return &Registry{path: path}
}

func (r *Registry) All() []AgentSpec {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.list != nil && time.Since(r.at) < 5*time.Second {
		return r.list
	}
	byID := map[string]AgentSpec{}
	order := []string{}
	for _, a := range defaultAgents {
		byID[a.ID] = a
		order = append(order, a.ID)
	}
	if raw, err := os.ReadFile(r.path); err == nil {
		var extra []AgentSpec
		if json.Unmarshal(raw, &extra) == nil {
			for _, a := range extra {
				if !chatIDRE.MatchString(a.ID) {
					continue
				}
				if _, seen := byID[a.ID]; !seen {
					order = append(order, a.ID)
				}
				if len(a.Command) == 0 {
					delete(byID, a.ID)
					continue
				}
				if a.Label == "" {
					a.Label = a.ID
				}
				byID[a.ID] = a
			}
		}
	}
	list := []AgentSpec{}
	for _, id := range order {
		if a, ok := byID[id]; ok {
			list = append(list, a)
		}
	}
	r.list = list
	r.at = time.Now()
	return list
}

func (r *Registry) Get(id string) (AgentSpec, bool) {
	for _, a := range r.All() {
		if a.ID == id {
			return a, true
		}
	}
	return AgentSpec{}, false
}

type CatalogEntry struct {
	ID            string          `json:"id"`
	Label         string          `json:"label"`
	Installed     bool            `json:"installed"`
	Available     bool            `json:"available"`
	Error         string          `json:"error,omitempty"`
	Version       string          `json:"version,omitempty"`
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
	Models        json.RawMessage `json:"models,omitempty"`
	Modes         json.RawMessage `json:"modes,omitempty"`
	ProbedAt      int64           `json:"probedAt,omitempty"`
	stamp         string
}

type Catalog struct {
	d       *Daemon
	mu      sync.Mutex
	entries map[string]CatalogEntry
	probing bool
}

func NewCatalog(d *Daemon) *Catalog {
	c := &Catalog{d: d, entries: map[string]CatalogEntry{}}
	if raw, err := os.ReadFile(c.cachePath()); err == nil {
		var saved []catalogFile
		if json.Unmarshal(raw, &saved) == nil {
			for _, f := range saved {
				e := f.CatalogEntry
				e.stamp = f.Stamp
				c.entries[e.ID] = e
			}
		}
	}
	return c
}

func (c *Catalog) cachePath() string {
	return filepath.Join(c.d.stateDir, "catalog.json")
}

type catalogFile struct {
	CatalogEntry
	Stamp string `json:"stamp"`
}

func binaryStamp(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%s:%d:%d", path, st.Size(), st.ModTime().UnixNano())
}

func (c *Catalog) Snapshot(refresh bool) map[string]any {
	if refresh {
		go c.Refresh(true)
	}
	env := c.d.env.Get(context.Background())
	c.mu.Lock()
	defer c.mu.Unlock()
	out := []CatalogEntry{}
	for _, spec := range c.d.agents.All() {
		e, ok := c.entries[spec.ID]
		bin := lookPath(mergeEnv(env, spec.Env), spec.Command[0])
		if !ok {
			e = CatalogEntry{ID: spec.ID, Label: spec.Label}
		}
		e.Label = spec.Label
		e.Installed = bin != ""
		if !e.Installed {
			e.Available = false
		}
		out = append(out, e)
	}
	return map[string]any{"agents": out, "probing": c.probing}
}

func (c *Catalog) Refresh(force bool) {
	c.mu.Lock()
	if c.probing {
		c.mu.Unlock()
		return
	}
	c.probing = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.probing = false
		c.mu.Unlock()
		c.d.broadcast("agent.catalog", c.Snapshot(false))
	}()
	env := c.d.env.Get(context.Background())
	probeDir := filepath.Join(c.d.stateDir, "probe")
	_ = os.MkdirAll(probeDir, 0o755)
	c.d.chown(probeDir)
	for _, spec := range c.d.agents.All() {
		bin := lookPath(mergeEnv(env, spec.Env), spec.Command[0])
		if bin == "" {
			continue
		}
		stamp := binaryStamp(bin)
		c.mu.Lock()
		prev, ok := c.entries[spec.ID]
		c.mu.Unlock()
		if ok && !force && prev.stamp == stamp && prev.Available {
			continue
		}
		entry := c.probe(spec, probeDir)
		entry.stamp = stamp
		c.mu.Lock()
		c.entries[spec.ID] = entry
		c.mu.Unlock()
	}
	c.save()
}

func (c *Catalog) probe(spec AgentSpec, dir string) CatalogEntry {
	entry := CatalogEntry{ID: spec.ID, Label: spec.Label, Installed: true, ProbedAt: time.Now().UnixMilli()}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	proc, err := c.d.spawnAgent(ctx, spec, spawnOptions{Dir: dir, Env: c.d.env.Get(ctx)})
	if err != nil {
		entry.Error = asRPCError(err).Message
		return entry
	}
	defer proc.Kill()
	var info struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(proc.init.AgentInfo, &info)
	entry.Version = info.Version
	state, err := proc.NewSession(ctx, dir, nil)
	if err != nil {
		entry.Error = asRPCError(err).Message
		return entry
	}
	proc.CloseSession(ctx, state.SessionID)
	entry.Available = true
	entry.ConfigOptions = state.ConfigOptions
	entry.Models = state.Models
	entry.Modes = state.Modes
	return entry
}

func (c *Catalog) save() {
	c.mu.Lock()
	list := []catalogFile{}
	for _, e := range c.entries {
		list = append(list, catalogFile{CatalogEntry: e, Stamp: e.stamp})
	}
	c.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	raw, err := json.Marshal(list)
	if err != nil {
		return
	}
	tmp := c.cachePath() + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		_ = os.Rename(tmp, c.cachePath())
		c.d.chown(c.cachePath())
	}
}

func (c *Catalog) Get(id string) (CatalogEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[id]
	return e, ok
}
