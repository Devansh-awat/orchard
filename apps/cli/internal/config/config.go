package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var DefaultAPIURL string

var Override string

type Config struct {
	Name        string  `json:"-"`
	MakeCurrent bool    `json:"-"`
	APIURL      string  `json:"apiUrl"`
	Token       string  `json:"token"`
	Context     Context `json:"context,omitzero"`
}

type Context struct {
	OrgID       string `json:"orgId,omitempty"`
	OrgSlug     string `json:"orgSlug,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectSlug string `json:"projectSlug,omitempty"`
	EnvID       string `json:"envId,omitempty"`
	EnvName     string `json:"envName,omitempty"`
}

type Entry struct {
	APIURL  string  `json:"apiUrl"`
	Token   string  `json:"token,omitempty"`
	Context Context `json:"context,omitzero"`
}

type File struct {
	Current  string           `json:"current"`
	Contexts map[string]Entry `json:"contexts"`
}

type legacyFile struct {
	APIURL   string           `json:"apiUrl"`
	Token    string           `json:"token"`
	Context  Context          `json:"context,omitzero"`
	Current  string           `json:"current"`
	Contexts map[string]Entry `json:"contexts"`
}

var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`)

func ValidName(name string) bool { return nameRE.MatchString(name) }

func dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".orchard"), nil
}

func path() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

func NameForURL(apiURL string) string {
	u, err := url.Parse(apiURL)
	if err != nil || u.Hostname() == "" {
		return "default"
	}
	host := strings.TrimPrefix(u.Hostname(), "www.")
	if port := u.Port(); port != "" {
		host += "-" + port
	}
	name := strings.Trim(regexp.MustCompile(`[^a-zA-Z0-9._-]+`).ReplaceAllString(host, "-"), "-.")
	if !ValidName(name) {
		return "default"
	}
	return name
}

func LoadFile() (*File, error) {
	f := &File{Contexts: map[string]Entry{}}
	p, err := path()
	if err != nil {
		return f, nil
	}
	data, rerr := os.ReadFile(p)
	if errors.Is(rerr, os.ErrNotExist) {
		return f, nil
	}
	if rerr != nil {
		return f, fmt.Errorf("couldn't read %s: %w", p, rerr)
	}
	var raw legacyFile
	if err := json.Unmarshal(data, &raw); err != nil {
		return f, fmt.Errorf("couldn't parse %s: %w: fix or remove the file", p, err)
	}
	for name, e := range raw.Contexts {
		if ValidName(name) {
			f.Contexts[name] = e
		}
	}
	f.Current = raw.Current
	if len(f.Contexts) == 0 && (raw.APIURL != "" || raw.Token != "") {
		name := NameForURL(raw.APIURL)
		f.Contexts[name] = Entry{APIURL: raw.APIURL, Token: raw.Token, Context: raw.Context}
		f.Current = name
	}
	if _, ok := f.Contexts[f.Current]; !ok {
		f.Current = ""
		if names := f.Names(); len(names) > 0 {
			f.Current = names[0]
		}
	}
	return f, nil
}

func (f *File) Names() []string {
	names := make([]string, 0, len(f.Contexts))
	for name := range f.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (f *File) FindByURL(apiURL string) (string, bool) {
	for _, name := range f.Names() {
		if sameURL(f.Contexts[name].APIURL, apiURL) {
			return name, true
		}
	}
	return "", false
}

func (f *File) UniqueName(base string) string {
	if !ValidName(base) {
		base = "default"
	}
	name := base
	for n := 2; ; n++ {
		if _, taken := f.Contexts[name]; !taken {
			return name
		}
		name = fmt.Sprintf("%s-%d", base, n)
	}
}

func (f *File) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(d, "config.json.tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(d, "config.json"))
}

func Selected(f *File) string {
	if Override != "" {
		return Override
	}
	if v := os.Getenv("ORCHARD_CONTEXT"); v != "" {
		return v
	}
	return f.Current
}

func Load() (*Config, error) {
	f, err := LoadFile()
	if err != nil {
		return nil, err
	}
	name := Selected(f)
	c := &Config{Name: name, APIURL: DefaultAPIURL}
	if e, ok := f.Contexts[name]; ok {
		c.APIURL, c.Token, c.Context = e.APIURL, e.Token, e.Context
	} else if name != "" && name != f.Current {
		return nil, fmt.Errorf("no context named %q: run `orchard context list`", name)
	}
	if v := os.Getenv("ORCHARD_API_URL"); v != "" {
		c.APIURL = v
	}
	if v := os.Getenv("ORCHARD_API_TOKEN"); v != "" {
		c.Token = v
	}
	if c.APIURL == "" {
		c.APIURL = DefaultAPIURL
	}
	return c, nil
}

func (c *Config) Save() error {
	f, err := LoadFile()
	if err != nil {
		return err
	}
	name := c.Name
	if name == "" {
		if existing, ok := f.FindByURL(c.APIURL); ok {
			name = existing
		} else {
			name = f.UniqueName(NameForURL(c.APIURL))
		}
		c.Name = name
	}
	f.Contexts[name] = Entry{APIURL: c.APIURL, Token: c.Token, Context: c.Context}
	if f.Current == "" || c.MakeCurrent {
		f.Current = name
	}
	return f.Save()
}

func (c *Config) ForInstance(apiURL, name string) (*Config, error) {
	apiURL = strings.TrimRight(apiURL, "/")
	if name != "" && !ValidName(name) {
		return nil, fmt.Errorf("invalid context name %q: use letters, numbers, dots, dashes or underscores", name)
	}
	f, err := LoadFile()
	if err != nil {
		return nil, err
	}
	if name != "" {
		if e, ok := f.Contexts[name]; ok {
			if !sameURL(e.APIURL, apiURL) {
				return nil, fmt.Errorf("context %q already points at %s", name, e.APIURL)
			}
			return &Config{Name: name, APIURL: e.APIURL, Token: e.Token, Context: e.Context, MakeCurrent: true}, nil
		}
		return &Config{Name: name, APIURL: apiURL, MakeCurrent: true}, nil
	}
	if e, ok := f.Contexts[c.Name]; ok && c.Name != "" && sameURL(e.APIURL, apiURL) && sameURL(c.APIURL, apiURL) {
		c.MakeCurrent = true
		return c, nil
	}
	if existing, ok := f.FindByURL(apiURL); ok {
		e := f.Contexts[existing]
		return &Config{Name: existing, APIURL: e.APIURL, Token: e.Token, Context: e.Context, MakeCurrent: true}, nil
	}
	return &Config{Name: f.UniqueName(NameForURL(apiURL)), APIURL: apiURL, MakeCurrent: true}, nil
}

func (c *Config) HasInstance() bool { return c.APIURL != "" }

func (c *Config) RequireToken() error {
	if c.Token == "" {
		return errors.New("not signed in: run `orchard auth login` or set ORCHARD_API_TOKEN")
	}
	return nil
}
