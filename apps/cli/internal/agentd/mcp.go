//go:build !windows

package agentd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func (d *Daemon) defaultMCP() []json.RawMessage {
	dir := d.opts.InitDir
	if dir == "" {
		dir = "/orchard-init"
	}
	raw, err := os.ReadFile(filepath.Join(dir, "opencode-config.json"))
	if err != nil {
		return nil
	}
	var cfg struct {
		MCP map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
			Enabled *bool             `json:"enabled"`
		} `json:"mcp"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return nil
	}
	out := []json.RawMessage{}
	for name, server := range cfg.MCP {
		if server.Type != "remote" || !strings.HasPrefix(server.URL, "http") || (server.Enabled != nil && !*server.Enabled) {
			continue
		}
		headers := []map[string]string{}
		for k, v := range server.Headers {
			headers = append(headers, map[string]string{"name": k, "value": v})
		}
		entry, err := json.Marshal(map[string]any{"type": "http", "name": name, "url": server.URL, "headers": headers})
		if err == nil {
			out = append(out, entry)
		}
	}
	return out
}

func (d *Daemon) mcpFor(explicit []json.RawMessage) []json.RawMessage {
	if len(explicit) > 0 {
		return explicit
	}
	return d.defaultMCP()
}
