package agentspec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Param struct {
	Name     string          `json:"name"`
	Required bool            `json:"required"`
	Schema   json.RawMessage `json:"schema,omitempty"`
}

type Params struct {
	Path  []Param `json:"path,omitempty"`
	Query []Param `json:"query,omitempty"`
}

type Operation struct {
	OperationID string          `json:"operationId"`
	Method      string          `json:"method"`
	Path        string          `json:"path"`
	Summary     string          `json:"summary"`
	Tags        []string        `json:"tags"`
	Scope       string          `json:"scope"`
	Params      *Params         `json:"params,omitempty"`
	RequestBody json.RawMessage `json:"requestBody,omitempty"`
	Response    json.RawMessage `json:"response,omitempty"`
	Sensitive   bool            `json:"x-orchard-sensitive,omitempty"`
	Destructive bool            `json:"x-orchard-destructive,omitempty"`
}

type Spec struct {
	Version    string      `json:"version"`
	Operations []Operation `json:"operations"`
}

type cacheFile struct {
	APIURL    string    `json:"apiUrl"`
	ETag      string    `json:"etag"`
	FetchedAt time.Time `json:"fetchedAt"`
	Spec      Spec      `json:"spec"`
}

const DefaultMaxAge = time.Hour

type Loader struct {
	APIURL    string
	CachePath string
	MaxAge    time.Duration
	HTTP      *http.Client
	Now       func() time.Time
	Refresh   bool
}

func DefaultCachePath() (string, error) {
	if dir := os.Getenv("ORCHARD_SPEC_CACHE_DIR"); dir != "" {
		return filepath.Join(dir, "agent-spec.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".orchard", "agent-spec.json"), nil
}

func (l *Loader) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

func (l *Loader) readCache() (*cacheFile, error) {
	data, err := os.ReadFile(l.CachePath)
	if err != nil {
		return nil, err
	}
	var c cacheFile
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if strings.TrimRight(c.APIURL, "/") != strings.TrimRight(l.APIURL, "/") || len(c.Spec.Operations) == 0 {
		return nil, errors.New("cached spec belongs to another server")
	}
	return &c, nil
}

func (l *Loader) writeCache(c *cacheFile) error {
	if err := os.MkdirAll(filepath.Dir(l.CachePath), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp := l.CachePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, l.CachePath)
}

func (l *Loader) Load(ctx context.Context) (*Spec, error) {
	maxAge := l.MaxAge
	if maxAge == 0 {
		maxAge = DefaultMaxAge
	}
	cached, _ := l.readCache()
	if cached != nil && !l.Refresh && l.now().Sub(cached.FetchedAt) < maxAge {
		return &cached.Spec, nil
	}

	fresh, err := l.fetch(ctx, cached)
	if err != nil {
		if cached != nil {
			return &cached.Spec, nil
		}
		return nil, err
	}
	_ = l.writeCache(fresh)
	return &fresh.Spec, nil
}

func (l *Loader) fetch(ctx context.Context, cached *cacheFile) (*cacheFile, error) {
	client := l.HTTP
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(l.APIURL, "/")+"/apiv1/agent-spec.json", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if cached != nil && cached.ETag != "" {
		req.Header.Set("If-None-Match", cached.ETag)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotModified && cached != nil {
		next := *cached
		next.FetchedAt = l.now()
		return &next, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetching agent spec: HTTP %d", res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	var spec Spec
	if err := json.Unmarshal(body, &spec); err != nil {
		return nil, fmt.Errorf("agent spec is not valid JSON: %w", err)
	}
	if len(spec.Operations) == 0 {
		return nil, errors.New("agent spec has no operations")
	}
	return &cacheFile{APIURL: l.APIURL, ETag: res.Header.Get("ETag"), FetchedAt: l.now(), Spec: spec}, nil
}
