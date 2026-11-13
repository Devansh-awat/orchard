package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	assetCSP       = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
	cacheImmutable = "public, max-age=31536000, immutable"
	cacheIndex     = "public, max-age=60, stale-while-revalidate=600"
	cacheDefault   = "public, max-age=300"
	maxCachedBody  = 2 << 20
	rootIndexKey   = "templates/index.json"
)

var (
	templateNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	versionedRe    = regexp.MustCompile(`^(?:templates|grafts)/[a-z0-9-]+/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/`)
	nameIndexRe    = regexp.MustCompile(`^templates/([a-z0-9-]+)/?$`)
	versionRe      = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	latestRe       = regexp.MustCompile(`^templates/([a-z0-9-]+)/latest/(.+)$`)
)

type policy struct {
	header string
	memory time.Duration
}

func cachePolicy(key string) policy {
	switch {
	case versionedRe.MatchString(key):
		return policy{cacheImmutable, time.Hour}
	case strings.HasSuffix(key, "/index.json"), strings.HasSuffix(key, "/index.json.sig"):
		return policy{cacheIndex, 30 * time.Second}
	default:
		return policy{cacheDefault, time.Minute}
	}
}

func contentTypeFor(key, stored string) string {
	if stored != "" && stored != "application/octet-stream" && stored != "binary/octet-stream" {
		return stored
	}
	switch strings.ToLower(path.Ext(key)) {
	case ".yaml", ".yml":
		return "application/yaml; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".md":
		return "text/markdown; charset=utf-8"
	case ".sh":
		return "text/x-shellscript; charset=utf-8"
	case ".txt":
		return "text/plain; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(key)); t != "" {
		return t
	}
	if stored != "" {
		return stored
	}
	return "application/octet-stream"
}

func servedDisposition(key, contentType, stored string) string {
	if d := dispositionFor(key, contentType); d != "" {
		return d
	}
	return stored
}

type entry struct {
	body         []byte
	etag         string
	contentType  string
	lastModified string
	disposition  string
	expires      time.Time
}

type server struct {
	bucket   *Bucket
	prefix   string
	basePath string
	mu       sync.Mutex
	cache    map[string]*entry
}

func newServer(bucket *Bucket, prefix string) *server {
	return &server{bucket: bucket, prefix: prefix, cache: map[string]*entry{}}
}

var basePathRe = regexp.MustCompile(`^(?:/[A-Za-z0-9._~-]+)*$`)

func normalizeBasePath(raw string) (string, error) {
	p := strings.TrimRight(strings.TrimSpace(raw), "/")
	if p == "" {
		return "", nil
	}
	if !basePathRe.MatchString(p) {
		return "", errors.New("REGISTRY_PUBLIC_BASE_PATH must be an absolute path such as /registry made of letters, digits and . _ ~ -")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." {
			return "", errors.New("REGISTRY_PUBLIC_BASE_PATH must not contain . or .. segments")
		}
	}
	return p, nil
}

func cleanKey(p string) (string, bool) {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return "", true
	}
	if strings.Contains(p, "//") || strings.Contains(p, "\\") {
		return "", false
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return "", false
		}
	}
	return p, true
}

func (s *server) resolve(p string) (key string, redirect string, ok bool) {
	key, ok = cleanKey(p)
	if !ok {
		return "", "", false
	}
	trimmed := strings.TrimSuffix(key, "/")
	switch {
	case trimmed == "" || trimmed == "templates":
		return rootIndexKey, "", true
	case trimmed == "grafts":
		return graftCatalogKey, "", true
	case nameIndexRe.MatchString(trimmed):
		return "templates/" + nameIndexRe.FindStringSubmatch(trimmed)[1] + "/index.json", "", true
	case latestRe.MatchString(key):
		m := latestRe.FindStringSubmatch(key)
		return "", "latest:" + m[1] + ":" + m[2], true
	}
	return key, "", true
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", assetCSP)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "If-None-Match, If-Modified-Since, Range")
	w.Header().Set("Access-Control-Expose-Headers", "ETag, Content-Length, Content-Range, Last-Modified, X-Registry-Version")
	w.Header().Set("X-Registry-Version", Version)

	switch r.Method {
	case http.MethodOptions:
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	case http.MethodGet, http.MethodHead:
	default:
		w.Header().Set("Allow", "GET, HEAD, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if r.URL.Path == "/healthz" {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok\n")
		return
	}

	key, redirect, ok := s.resolve(r.URL.Path)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if redirect != "" {
		s.redirectLatest(w, r, redirect)
		return
	}

	if r.Header.Get("Range") != "" {
		s.stream(w, r, key)
		return
	}

	e, status, err := s.fetch(r.Context(), key)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			w.Header().Set("Cache-Control", "public, max-age=30")
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Printf("fetch %s: %v", key, err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	if e == nil {
		s.streamStatus(w, r, key, status)
		return
	}

	pol := cachePolicy(key)
	h := w.Header()
	h.Set("Cache-Control", pol.header)
	h.Set("Content-Type", e.contentType)
	if e.disposition != "" {
		h.Set("Content-Disposition", e.disposition)
	}
	h.Set("Accept-Ranges", "bytes")
	if e.etag != "" {
		h.Set("ETag", e.etag)
	}
	if e.lastModified != "" {
		h.Set("Last-Modified", e.lastModified)
	}
	if e.etag != "" && etagMatches(r.Header.Get("If-None-Match"), e.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(e.body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		w.Write(e.body)
	}
}

func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == "*" || candidate == etag || candidate == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

func (s *server) fetch(ctx context.Context, key string) (*entry, int, error) {
	now := time.Now()
	s.mu.Lock()
	cached := s.cache[key]
	s.mu.Unlock()
	if cached != nil && now.Before(cached.expires) {
		return cached, http.StatusOK, nil
	}

	headers := http.Header{}
	if cached != nil && cached.etag != "" {
		headers.Set("If-None-Match", cached.etag)
	}
	resp, err := s.bucket.Get(ctx, s.prefix+key, headers)
	if err != nil {
		if cached != nil {
			return cached, http.StatusOK, nil
		}
		return nil, 0, err
	}
	defer resp.Body.Close()
	pol := cachePolicy(key)

	switch resp.StatusCode {
	case http.StatusNotModified:
		io.Copy(io.Discard, resp.Body)
		cached.expires = now.Add(pol.memory)
		s.mu.Lock()
		s.cache[key] = cached
		s.mu.Unlock()
		return cached, http.StatusOK, nil
	case http.StatusNotFound:
		io.Copy(io.Discard, resp.Body)
		s.mu.Lock()
		delete(s.cache, key)
		s.mu.Unlock()
		return nil, 0, ErrNotFound
	case http.StatusOK:
	default:
		io.Copy(io.Discard, resp.Body)
		return nil, 0, errors.New("upstream answered " + resp.Status)
	}

	if resp.ContentLength < 0 || resp.ContentLength > maxCachedBody {
		return nil, resp.StatusCode, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCachedBody+1))
	if err != nil {
		return nil, 0, err
	}
	if len(body) > maxCachedBody {
		return nil, resp.StatusCode, nil
	}
	ctype := contentTypeFor(key, resp.Header.Get("Content-Type"))
	e := &entry{
		body:         body,
		etag:         resp.Header.Get("ETag"),
		contentType:  ctype,
		lastModified: resp.Header.Get("Last-Modified"),
		disposition:  servedDisposition(key, ctype, resp.Header.Get("Content-Disposition")),
		expires:      now.Add(pol.memory),
	}
	s.mu.Lock()
	s.cache[key] = e
	s.mu.Unlock()
	return e, http.StatusOK, nil
}

func (s *server) streamStatus(w http.ResponseWriter, r *http.Request, key string, _ int) {
	s.stream(w, r, key)
}

func (s *server) stream(w http.ResponseWriter, r *http.Request, key string) {
	resp, err := s.bucket.Get(r.Context(), s.prefix+key, r.Header)
	if err != nil {
		log.Printf("stream %s: %v", key, err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusNotModified, http.StatusRequestedRangeNotSatisfiable:
	case http.StatusNotFound:
		http.Error(w, "not found", http.StatusNotFound)
		return
	default:
		io.Copy(io.Discard, resp.Body)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	h := w.Header()
	for _, name := range []string{"Content-Length", "Content-Range", "ETag", "Last-Modified", "Accept-Ranges"} {
		if v := resp.Header.Get(name); v != "" {
			h.Set(name, v)
		}
	}
	ctype := contentTypeFor(key, resp.Header.Get("Content-Type"))
	h.Set("Content-Type", ctype)
	if d := servedDisposition(key, ctype, resp.Header.Get("Content-Disposition")); d != "" {
		h.Set("Content-Disposition", d)
	}
	h.Set("Cache-Control", cachePolicy(key).header)
	w.WriteHeader(resp.StatusCode)
	if r.Method == http.MethodGet {
		io.Copy(w, resp.Body)
	}
}

type nameIndex struct {
	Latest string `json:"latest"`
}

func (s *server) redirectLatest(w http.ResponseWriter, r *http.Request, spec string) {
	parts := strings.SplitN(spec, ":", 3)
	name, file := parts[1], parts[2]
	if !templateNameRe.MatchString(name) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	e, _, err := s.fetch(r.Context(), "templates/"+name+"/index.json")
	if err != nil || e == nil {
		w.Header().Set("Cache-Control", "public, max-age=30")
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var idx nameIndex
	if err := json.Unmarshal(e.body, &idx); err != nil || idx.Latest == "" {
		http.Error(w, "index unreadable", http.StatusBadGateway)
		return
	}
	if !versionRe.MatchString(idx.Latest) {
		http.Error(w, "index unreadable", http.StatusBadGateway)
		return
	}
	target := (&url.URL{Path: path.Join("/", s.basePath, "templates", name, idx.Latest, file)}).String()
	w.Header().Set("Cache-Control", cacheIndex)
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusFound)
}
