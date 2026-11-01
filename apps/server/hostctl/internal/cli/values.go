package cli

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Values is the chart values file. Editing it in Go rather than shelling out to
// yq is most of the reason this command stopped being a shell script: a list of
// objects like builders.registryEgress is painful to manipulate through a yq
// expression and easy here.
type Values struct {
	path string
	root map[string]any
}

func LoadValues(path string) (*Values, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("could not read %s: %w", path, err)
	}
	root := map[string]any{}
	if err := yaml.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("could not parse %s: %w", path, err)
	}
	if root == nil {
		root = map[string]any{}
	}
	return &Values{path: path, root: root}, nil
}

func (v *Values) Save() error {
	out, err := yaml.Marshal(v.root)
	if err != nil {
		return err
	}
	// The values file holds credentials, so it must not widen on rewrite.
	return os.WriteFile(v.path, out, 0o600)
}

func (v *Values) Root() map[string]any { return v.root }

// Get resolves a dotted path. Missing segments read as nil rather than an
// error, so `config get` on an unset key prints nothing instead of failing.
func (v *Values) Get(path string) any {
	cur := any(v.root)
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur, ok = m[part]
		if !ok {
			return nil
		}
	}
	return cur
}

// Set writes a dotted path, creating intermediate maps. The value is parsed as
// YAML so true/false and numbers keep their own type while a bare word stays a
// string, which is what `config set signupMode invite_only` needs.
func (v *Values) Set(path, raw string) error {
	return v.Put(path, parseScalar(raw))
}

type ListPathError struct {
	Path string
	List string
	Verb string
}

func (e *ListPathError) Error() string {
	verb, consequence := e.Verb, "replace"
	if verb == "" {
		verb = "setting"
	}
	if verb == "unsetting" {
		consequence = "remove"
	}
	if strings.HasSuffix(e.List, ".env") || e.List == "env" {
		return fmt.Sprintf("%s is a list of environment variables, and %s %s would %s every one of them; use orchardctl env set|unset <NAME> instead", e.List, verb, e.Path, consequence)
	}
	return fmt.Sprintf("%s is a list, and %s %s would %s all of it; use orchardctl config edit instead", e.List, verb, e.Path, consequence)
}

func (v *Values) Put(path string, value any) error {
	parts := strings.Split(path, ".")
	cur := v.root
	for i, part := range parts[:len(parts)-1] {
		switch existing := cur[part].(type) {
		case map[string]any:
			cur = existing
			continue
		case []any:
			return &ListPathError{Path: path, List: strings.Join(parts[:i+1], ".")}
		}
		next := map[string]any{}
		cur[part] = next
		cur = next
	}
	last := parts[len(parts)-1]
	if _, isList := cur[last].([]any); isList {
		if _, replacing := value.([]any); !replacing {
			return &ListPathError{Path: path, List: path}
		}
	}
	cur[last] = value
	return nil
}

func (v *Values) Unset(path string) {
	parts := strings.Split(path, ".")
	cur := v.root
	for _, part := range parts[:len(parts)-1] {
		next, ok := cur[part].(map[string]any)
		if !ok {
			return
		}
		cur = next
	}
	delete(cur, parts[len(parts)-1])
}

// SetList replaces a dotted path with a list, creating intermediate maps.
func (v *Values) SetList(path string, items []any) {
	parts := strings.Split(path, ".")
	cur := v.root
	for _, part := range parts[:len(parts)-1] {
		next, ok := cur[part].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[part] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = items
}

// List reads a dotted path as a list, returning nil when unset or not a list.
func (v *Values) List(path string) []any {
	items, _ := v.Get(path).([]any)
	return items
}

// EnvValue reads one entry out of a chart env list such as server.env, which is
// a list of {name, value} maps rather than a map keyed by name.
func (v *Values) EnvValue(path, name string) string {
	for _, item := range v.List(path) {
		entry, ok := item.(map[string]any)
		if !ok || entry["name"] != name {
			continue
		}
		if value, ok := entry["value"].(string); ok {
			return value
		}
		return fmt.Sprintf("%v", entry["value"])
	}
	return ""
}

// SetEnv upserts one entry in a chart env list, leaving every other entry and
// its order alone. Appending instead would shadow rather than replace: a
// container env list takes the last definition of a name.
func (v *Values) SetEnv(path, name, value string) {
	items := v.List(path)
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if ok && entry["name"] == name {
			entry["value"] = value
			v.SetList(path, items)
			return
		}
	}
	v.SetList(path, append(items, map[string]any{"name": name, "value": value}))
}

func (v *Values) UnsetEnv(path, name string) bool {
	items := v.List(path)
	kept := make([]any, 0, len(items))
	removed := false
	for _, item := range items {
		if entry, ok := item.(map[string]any); ok && entry["name"] == name {
			removed = true
			continue
		}
		kept = append(kept, item)
	}
	if removed {
		v.SetList(path, kept)
	}
	return removed
}

func (v *Values) EnvNames(path string) []string {
	var names []string
	for _, item := range v.List(path) {
		if entry, ok := item.(map[string]any); ok {
			if name, ok := entry["name"].(string); ok {
				names = append(names, name)
			}
		}
	}
	return names
}

func parseScalar(raw string) any {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true":
		return true
	case "false":
		return false
	case "null", "~":
		return nil
	}
	if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
		return n
	}
	if f, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil {
		return f
	}
	return raw
}

// Render prints a value the way an operator expects to read it: scalars bare,
// anything structured as YAML.
func Render(value any) string {
	switch value.(type) {
	case nil:
		return ""
	case string, bool, int, float64:
		return fmt.Sprintf("%v", value)
	}
	out, err := yaml.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return strings.TrimRight(string(out), "\n")
}
