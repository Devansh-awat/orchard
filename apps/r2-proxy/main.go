// r2-proxy is an S3 V4 re-signing gateway. CNPG/barman pods authenticate to
// this service with a per-cluster fake access key. The proxy verifies the
// V4 signature, enforces a per-key bucket+prefix policy, then re-signs the
// request with the real R2 credentials and streams it to upstream R2.
//
// Threat model: a tenant who exec's into their CNPG pod gets the access key
// and secret out of the pod's k8s Secret. With the proxy in place those creds
// only work for that cluster's prefix. The real R2 credentials live only on
// the proxy (separate namespace, NetworkPolicy-fenced).
//
// Bindings come straight from orchard's Postgres `databases` table: there
// is no ConfigMap to drift from the source of truth. Lookups are cached
// in-memory for 60s on hit, 5s on miss.
//
// Configuration:
//
//	PROXY_LISTEN      address to listen on (default :9000)
//	R2_ENDPOINT       upstream S3 endpoint, any provider; optional when STORED_UPSTREAMS_FILE supplies one
//	R2_REGION         signing region for upstream (default "auto")
//	R2_PATH_STYLE     "false" sends requests to <bucket>.<host> instead of <host>/<bucket> (default "true")
//	R2_ACCESS_KEY     real access key id
//	R2_SECRET_KEY     real secret access key
//	DATABASE_URL      postgres URL pointing at orchard's database (read-only role recommended)
//	ALLOWED_BUCKETS   comma-separated buckets a binding may name (default: DEFAULT_BACKUP_BUCKET)
//	STORED_UPSTREAMS_FILE  JSON the server writes when storage is set in the UI, re-read while running
//
// Only the subset of S3 that barman/CNPG actually uses is supported:
// HEAD bucket, HEAD/PUT/GET/DELETE object, LIST objects v1/v2,
// initiate/upload-part/complete/abort multipart upload. Requests must use
// path-style addressing (bucket in the URL path, not the host).
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lib/pq"
)

// Version is set via -ldflags "-X main.Version=..." at build time.
var Version = "dev"

type Binding struct {
	AccessKey    string
	Secret       string
	Bucket       string
	Prefix       string
	ReadPrefixes []string
}

type cacheEntry struct {
	binding   Binding
	found     bool
	expiresAt time.Time
}

const (
	hitTTL       = 60 * time.Second
	missTTL      = 5 * time.Second
	maxCacheSize = 4096
	maxKeyLength = 128
	maxBodyBytes = 1 << 30

	maxControlBodyBytes = 8 << 20

	storedReloadInterval = 15 * time.Second
)

// bindingStore resolves access keys to bindings, backed by orchard's Postgres.
// A small TTL cache absorbs the steady-state load (barman makes many requests
// per backup) while still picking up new databases within ~missTTL of creation.
type bindingStore struct {
	db            *sql.DB
	defaultBucket string
	defaults      func() string

	mu    sync.RWMutex
	cache map[string]cacheEntry
}

func newBindingStore(db *sql.DB, defaultBucket string) *bindingStore {
	return &bindingStore{
		db:            db,
		defaultBucket: defaultBucket,
		cache:         map[string]cacheEntry{},
	}
}

func (s *bindingStore) fallbackBucket() string {
	if s.defaults != nil {
		return s.defaults()
	}
	return s.defaultBucket
}

func (s *bindingStore) get(ak string) (Binding, bool) {
	now := time.Now()

	s.mu.RLock()
	if hit, ok := s.cache[ak]; ok && hit.expiresAt.After(now) {
		s.mu.RUnlock()
		return hit.binding, hit.found
	}
	s.mu.RUnlock()

	// Cache miss / expired: hit the DB.
	b, found, err := s.lookup(ak)
	if err != nil {
		// On DB error, fall through to whatever stale entry we have rather
		// than locking out an in-flight backup. Log it so it's visible.
		log.Printf("[r2-proxy] db lookup ak=%s error: %v", ak, err)
		s.mu.RLock()
		if hit, ok := s.cache[ak]; ok {
			s.mu.RUnlock()
			return hit.binding, hit.found
		}
		s.mu.RUnlock()
		return Binding{}, false
	}

	ttl := hitTTL
	if !found {
		ttl = missTTL
	}
	s.mu.Lock()
	if len(s.cache) >= maxCacheSize {
		for k, e := range s.cache {
			if !e.expiresAt.After(now) {
				delete(s.cache, k)
			}
		}
		if len(s.cache) >= maxCacheSize {
			s.cache = map[string]cacheEntry{}
		}
	}
	s.cache[ak] = cacheEntry{binding: b, found: found, expiresAt: now.Add(ttl)}
	s.mu.Unlock()
	return b, found
}

func (s *bindingStore) lookup(ak string) (Binding, bool, error) {
	const q = `
		SELECT d.r2_proxy_access_key,
		       d.r2_proxy_secret,
		       d.namespace,
		       d.cluster_name,
		       COALESCE(o.backup_r2_bucket, NULLIF($2, ''))
		FROM databases d
		JOIN projects p      ON p.id = d.project_id
		JOIN organizations o ON o.id = p.organization_id
		WHERE d.r2_proxy_access_key = $1
		  AND d.r2_proxy_access_key IS NOT NULL
		  AND d.r2_proxy_secret     IS NOT NULL
		  AND d.namespace           IS NOT NULL
		  AND d.cluster_name        IS NOT NULL
		  AND COALESCE(o.backup_r2_bucket, NULLIF($2, '')) IS NOT NULL
		LIMIT 1`

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var b Binding
	var ns, cluster string
	err := s.db.QueryRowContext(ctx, q, ak, s.fallbackBucket()).Scan(&b.AccessKey, &b.Secret, &ns, &cluster, &b.Bucket)
	if errors.Is(err, sql.ErrNoRows) {
		return s.lookupRestore(ctx, ak)
	}
	if err != nil {
		return Binding{}, false, err
	}
	// Trailing slash on the prefix so "ns/db1" doesn't accidentally match "ns/db10/...".
	b.Prefix = ns + "/" + cluster + "/"
	return b, true, nil
}

func (s *bindingStore) lookupRestore(ctx context.Context, ak string) (Binding, bool, error) {
	const q = `
		SELECT d.r2_restore_access_key,
		       d.r2_restore_secret,
		       d.namespace,
		       d.r2_restore_cluster_name,
		       d.cluster_name,
		       COALESCE(o.backup_r2_bucket, NULLIF($2, ''))
		FROM databases d
		JOIN projects p      ON p.id = d.project_id
		JOIN organizations o ON o.id = p.organization_id
		WHERE d.r2_restore_access_key = $1
		  AND d.r2_restore_secret       IS NOT NULL
		  AND d.r2_restore_cluster_name IS NOT NULL
		  AND d.namespace               IS NOT NULL
		  AND d.cluster_name            IS NOT NULL
		  AND COALESCE(o.backup_r2_bucket, NULLIF($2, '')) IS NOT NULL
		LIMIT 1`

	var b Binding
	var ns, restoreCluster, sourceCluster string
	err := s.db.QueryRowContext(ctx, q, ak, s.fallbackBucket()).Scan(&b.AccessKey, &b.Secret, &ns, &restoreCluster, &sourceCluster, &b.Bucket)
	if errors.Is(err, sql.ErrNoRows) {
		return s.lookupScoped(ctx, ak)
	}
	if err != nil {
		log.Printf("[r2-proxy] restore binding lookup ak=%s error: %v", ak, err)
		return Binding{}, false, nil
	}
	b.Prefix = ns + "/" + restoreCluster + "/"
	b.ReadPrefixes = []string{ns + "/" + sourceCluster + "/"}
	return b, true, nil
}

// Short-lived keys the server mints for one recovery job: a fork, an undelete
// or a restore drill. They read the source's prefixes and write only their own.
func (s *bindingStore) lookupScoped(ctx context.Context, ak string) (Binding, bool, error) {
	const q = `
		SELECT k.access_key,
		       k.secret,
		       k.write_prefix,
		       k.read_prefixes,
		       COALESCE(o.backup_r2_bucket, NULLIF($2, ''))
		FROM storage_access_keys k
		JOIN organizations o ON o.id = k.organization_id
		WHERE k.access_key = $1
		  AND k.expires_at > (NOW() AT TIME ZONE 'UTC')
		  AND k.write_prefix <> ''
		  AND COALESCE(o.backup_r2_bucket, NULLIF($2, '')) IS NOT NULL
		LIMIT 1`

	var b Binding
	var reads pq.StringArray
	err := s.db.QueryRowContext(ctx, q, ak, s.fallbackBucket()).Scan(&b.AccessKey, &b.Secret, &b.Prefix, &reads, &b.Bucket)
	if errors.Is(err, sql.ErrNoRows) {
		return Binding{}, false, nil
	}
	if err != nil {
		log.Printf("[r2-proxy] scoped binding lookup ak=%s error: %v", ak, err)
		return Binding{}, false, nil
	}
	b.Prefix = withSlash(b.Prefix)
	for _, r := range reads {
		if r != "" {
			b.ReadPrefixes = append(b.ReadPrefixes, withSlash(r))
		}
	}
	return b, true, nil
}

func withSlash(prefix string) string {
	if strings.HasSuffix(prefix, "/") {
		return prefix
	}
	return prefix + "/"
}

type upstream struct {
	url       *url.URL
	region    string
	accessKey string
	secretKey string
	pathStyle bool
}

func (u *upstream) requestURL(bucket, key, path string) url.URL {
	out := *u.url
	if u.pathStyle {
		out.Path = path
		return out
	}
	out.Host = bucket + "." + u.url.Host
	out.Path = "/" + key
	return out
}

type upstreamTable struct {
	base          *upstream
	baseBuckets   map[string]bool
	stored        map[string]*upstream
	defaultBucket string
}

func (t *upstreamTable) forBucket(bucket string) *upstream {
	if u, ok := t.stored[bucket]; ok {
		return u
	}
	if t.base != nil && (len(t.baseBuckets) == 0 || t.baseBuckets[bucket]) {
		return t.base
	}
	return nil
}

func (t *upstreamTable) isPlatform(bucket string) bool {
	if _, ok := t.stored[bucket]; ok {
		return true
	}
	return t.baseBuckets[bucket]
}

type storedTarget struct {
	Bucket    string `json:"bucket"`
	Endpoint  string `json:"endpoint"`
	Region    string `json:"region"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
	PathStyle *bool  `json:"pathStyle"`
}

type storedFile struct {
	DefaultBucket string         `json:"defaultBucket"`
	Targets       []storedTarget `json:"targets"`
}

func parseStored(raw []byte) (string, map[string]*upstream, error) {
	var file storedFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return "", nil, errors.New("not valid JSON")
	}
	out := map[string]*upstream{}
	for _, t := range file.Targets {
		parsed, err := url.Parse(strings.TrimRight(t.Endpoint, "/"))
		if err != nil || parsed.Host == "" || t.Bucket == "" || t.AccessKey == "" || t.SecretKey == "" {
			return "", nil, fmt.Errorf("target for bucket %q is incomplete", t.Bucket)
		}
		region := t.Region
		if region == "" {
			region = "auto"
		}
		out[t.Bucket] = &upstream{
			url:       parsed,
			region:    region,
			accessKey: t.AccessKey,
			secretKey: t.SecretKey,
			pathStyle: t.PathStyle == nil || *t.PathStyle,
		}
	}
	return file.DefaultBucket, out, nil
}

type Proxy struct {
	upstreamService string
	policy          *bindingStore
	upstreams       atomic.Pointer[upstreamTable]
	client          *http.Client
}

func (p *Proxy) reloadStored(path string, base upstreamTable, last *[]byte) {
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		raw = nil
	case err != nil:
		log.Printf("[r2-proxy] could not read stored upstreams: %v", err)
		return
	}
	if bytes.Equal(raw, *last) && p.upstreams.Load() != nil {
		return
	}
	next := base
	if raw != nil {
		defaultBucket, stored, err := parseStored(raw)
		if err != nil {
			log.Printf("[r2-proxy] ignoring stored upstreams: %v", err)
			return
		}
		next.stored = stored
		if defaultBucket != "" {
			next.defaultBucket = defaultBucket
		}
	}
	*last = raw
	p.upstreams.Store(&next)
	log.Printf("[r2-proxy] upstreams: %d stored, default bucket %q", len(next.stored), next.defaultBucket)
}

func baseUpstream() (*upstream, error) {
	endpoint := os.Getenv("R2_ENDPOINT")
	if endpoint == "" {
		return nil, nil
	}
	parsed, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("R2_ENDPOINT invalid: %v", err)
	}
	return &upstream{
		url:       parsed,
		region:    envDefault("R2_REGION", "auto"),
		accessKey: mustEnv("R2_ACCESS_KEY"),
		secretKey: mustEnv("R2_SECRET_KEY"),
		pathStyle: !strings.EqualFold(os.Getenv("R2_PATH_STYLE"), "false"),
	}, nil
}

func main() {
	log.Printf("r2-proxy version %s", Version)
	listen := envDefault("PROXY_LISTEN", ":9000")
	dbURL := mustEnv("DATABASE_URL")

	base, err := baseUpstream()
	if err != nil {
		log.Fatal(err)
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)

	// Eager-ping so we fail fast if creds are wrong, rather than crash on
	// first request. Don't fatally exit though: DB blip during boot
	// shouldn't take the proxy down indefinitely; we'll retry per request.
	{
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := db.PingContext(ctx); err != nil {
			log.Printf("[r2-proxy] db ping failed at boot: %v (will retry per-request)", err)
		}
		cancel()
	}

	defaultBucket := envDefault("DEFAULT_BACKUP_BUCKET", "")
	allowed := map[string]bool{}
	for _, b := range strings.Split(envDefault("ALLOWED_BUCKETS", defaultBucket), ",") {
		if b = strings.TrimSpace(b); b != "" {
			allowed[b] = true
		}
	}

	store := newBindingStore(db, defaultBucket)
	p := &Proxy{
		upstreamService: "s3",
		policy:          store,
		// No client-level timeout: backup uploads can be large/long. The
		// caller controls liveness via context (we don't add one, barman
		// has its own retry/timeout). If you front this with an ingress
		// proxy add idle-timeout there.
		client: &http.Client{},
	}
	store.defaults = func() string { return p.upstreams.Load().defaultBucket }

	storedPath := envDefault("STORED_UPSTREAMS_FILE", "/etc/r2-proxy/stored/upstreams.json")
	baseTable := upstreamTable{base: base, baseBuckets: allowed, defaultBucket: defaultBucket}
	var lastStored []byte
	p.reloadStored(storedPath, baseTable, &lastStored)
	go func() {
		for range time.Tick(storedReloadInterval) {
			p.reloadStored(storedPath, baseTable, &lastStored)
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/", p)

	if base != nil {
		log.Printf("[r2-proxy] listening %s, upstream=%s region=%s", listen, base.url, base.region)
	} else {
		log.Printf("[r2-proxy] listening %s, no upstream in the environment", listen)
	}
	server := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	if err := server.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Health/internal probes were already handled above.

	authz, err := parseAuthHeader(r.Header.Get("Authorization"))
	if err != nil {
		denyAndLog(w, r, "", "AccessDenied", err.Error())
		return
	}
	if len(authz.AccessKey) > maxKeyLength {
		denyAndLog(w, r, "", "InvalidAccessKeyId", "access key too long")
		return
	}

	binding, ok := p.policy.get(authz.AccessKey)
	if !ok {
		denyAndLog(w, r, authz.AccessKey, "InvalidAccessKeyId", "unknown access key")
		return
	}

	// Verify the V4 signature against the stored secret.
	if err := verifyV4(r, authz, binding.Secret); err != nil {
		denyAndLog(w, r, authz.AccessKey, "SignatureDoesNotMatch", err.Error())
		return
	}

	// Enforce bucket + prefix. Path-style addressing only: barman uses uri-style=path.
	bucket, key := splitPathStyle(r.URL.Path)
	if bucket == "" {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "missing bucket in path")
		return
	}
	table := p.upstreams.Load()
	if bucket != binding.Bucket && !(table.isPlatform(binding.Bucket) && table.isPlatform(bucket)) {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "bucket not allowed for this key")
		return
	}
	up := table.forBucket(bucket)
	if up == nil {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "bucket not served by this proxy")
		return
	}

	payload, err := prepareUpstreamBody(w, r, key)
	if err != nil {
		s3Error(w, http.StatusRequestEntityTooLarge, "EntityTooLarge", "body too large or unreadable")
		return
	}
	contentSha := payload.sha

	if code, msg, ok := authorizeBinding(r, key, binding, payload.inspect); !ok {
		denyAndLog(w, r, authz.AccessKey, code, msg)
		return
	}

	upURL := up.requestURL(bucket, key, r.URL.Path)
	upURL.RawQuery = r.URL.RawQuery

	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, upURL.String(), payload.reader)
	if err != nil {
		s3Error(w, http.StatusInternalServerError, "InternalError", "upstream request build failed")
		return
	}
	outReq.ContentLength = payload.length
	// Carry through most headers but strip auth-related ones; we'll add fresh ones.
	copyForwardHeaders(r.Header, outReq.Header)
	outReq.Host = upURL.Host
	outReq.Header.Set("Host", upURL.Host)
	outReq.Header.Set("x-amz-content-sha256", contentSha)
	outReq.Header.Set("x-amz-date", time.Now().UTC().Format("20060102T150405Z"))
	outReq.Header.Del("Authorization")

	signRequest(outReq, up.accessKey, up.secretKey, up.region, p.upstreamService, contentSha)

	resp, err := p.client.Do(outReq)
	if err != nil {
		log.Printf("[r2-proxy] %s %s ak=%s upstream-error: %v", r.Method, r.URL.Path, authz.AccessKey, err)
		s3Error(w, http.StatusBadGateway, "InternalError", "upstream error")
		return
	}
	defer resp.Body.Close()
	log.Printf("[r2-proxy] %s %s ak=%s → %d", r.Method, r.URL.Path, authz.AccessKey, resp.StatusCode)

	// Stream response back. Don't add or rewrite headers: barman/aws-sdk
	// validates ETag, Content-Length, and the various x-amz-* headers it set.
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

type sigv4Authz struct {
	AccessKey     string
	Date          string // YYYYMMDD
	Region        string
	Service       string
	SignedHeaders []string
	Signature     string
}

func parseAuthHeader(h string) (sigv4Authz, error) {
	var out sigv4Authz
	if h == "" {
		return out, errors.New("missing Authorization")
	}
	const prefix = "AWS4-HMAC-SHA256 "
	if !strings.HasPrefix(h, prefix) {
		return out, errors.New("unsupported auth scheme")
	}
	rest := h[len(prefix):]
	parts := strings.Split(rest, ",")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		switch {
		case strings.HasPrefix(p, "Credential="):
			cred := strings.TrimPrefix(p, "Credential=")
			// AK/YYYYMMDD/REGION/SERVICE/aws4_request
			f := strings.Split(cred, "/")
			if len(f) < 5 {
				return out, errors.New("malformed Credential")
			}
			out.AccessKey = f[0]
			out.Date = f[1]
			out.Region = f[2]
			out.Service = f[3]
		case strings.HasPrefix(p, "SignedHeaders="):
			out.SignedHeaders = strings.Split(strings.TrimPrefix(p, "SignedHeaders="), ";")
		case strings.HasPrefix(p, "Signature="):
			out.Signature = strings.TrimPrefix(p, "Signature=")
		}
	}
	if out.AccessKey == "" || out.Signature == "" || len(out.SignedHeaders) == 0 {
		return out, errors.New("incomplete Authorization")
	}
	return out, nil
}

// verifyV4 reconstructs the canonical request the client signed and compares
// the resulting signature against what they sent. The payload hash is taken
// at face value from x-amz-content-sha256 (we don't re-hash the body, large
// streaming uploads would otherwise need to be buffered). For our threat model
// (inside-the-cluster attacker who already has the secret) body-tamper isn't
// in scope; the value of the signature check is rejecting use of a leaked
// access key without the secret.
// Reject signatures whose x-amz-date drifts more than this much from now.
// Matches the standard SigV4 server skew window and stops indefinite replay.
const sigv4MaxSkew = 5 * time.Minute

func verifyV4(r *http.Request, authz sigv4Authz, secret string) error {
	contentSha := r.Header.Get("x-amz-content-sha256")
	if contentSha == "" {
		contentSha = "UNSIGNED-PAYLOAD"
	}
	dateHdr := r.Header.Get("x-amz-date")
	if dateHdr == "" {
		// Try the Date header as fallback (older SDKs).
		dateHdr = r.Header.Get("Date")
	}
	if dateHdr == "" {
		return errors.New("missing x-amz-date")
	}

	signedAt, err := parseSigV4Date(dateHdr)
	if err != nil {
		return fmt.Errorf("invalid x-amz-date: %w", err)
	}
	skew := time.Since(signedAt)
	if skew < 0 {
		skew = -skew
	}
	if skew > sigv4MaxSkew {
		return errors.New("request expired (clock skew)")
	}

	cr := canonicalRequest(r, authz.SignedHeaders, contentSha)
	scope := authz.Date + "/" + authz.Region + "/" + authz.Service + "/aws4_request"
	sts := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		dateHdr,
		scope,
		hexSha256([]byte(cr)),
	}, "\n")

	key := deriveSigningKey(secret, authz.Date, authz.Region, authz.Service)
	expected := hex.EncodeToString(hmacSHA256(key, []byte(sts)))

	if !hmac.Equal([]byte(expected), []byte(authz.Signature)) {
		return errors.New("signature mismatch")
	}
	return nil
}

// parseSigV4Date accepts either the basic ISO 8601 form 20060102T150405Z
// (canonical x-amz-date) or RFC1123 from the legacy Date header.
func parseSigV4Date(s string) (time.Time, error) {
	if t, err := time.Parse("20060102T150405Z", s); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC1123, s); err == nil {
		return t.UTC(), nil
	}
	if t, err := time.Parse(time.RFC1123Z, s); err == nil {
		return t.UTC(), nil
	}
	return time.Time{}, errors.New("unrecognised date format")
}

func canonicalRequest(r *http.Request, signedHeaders []string, contentSha string) string {
	canonURI := canonicalURI(r.URL.Path)
	canonQuery := canonicalQuery(r.URL.RawQuery)

	// signedHeaders comes from the Authorization header; the spec says these
	// are already lowercased and sorted.
	var hb strings.Builder
	for _, h := range signedHeaders {
		hb.WriteString(h)
		hb.WriteByte(':')
		if h == "host" {
			hb.WriteString(strings.ToLower(r.Host))
		} else {
			hb.WriteString(strings.TrimSpace(r.Header.Get(h)))
		}
		hb.WriteByte('\n')
	}

	return strings.Join([]string{
		r.Method,
		canonURI,
		canonQuery,
		hb.String(),
		strings.Join(signedHeaders, ";"),
		contentSha,
	}, "\n")
}

func canonicalURI(p string) string {
	if p == "" {
		return "/"
	}
	// Each segment is percent-encoded per RFC 3986. Slashes between segments
	// are preserved. AWS S3 canonical-URI does NOT double-encode slashes.
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = uriEscape(s, false)
	}
	return strings.Join(segs, "/")
}

func canonicalQuery(q string) string {
	if q == "" {
		return ""
	}
	pairs := strings.Split(q, "&")
	type kv struct{ k, v string }
	kvs := make([]kv, 0, len(pairs))
	for _, p := range pairs {
		if p == "" {
			continue
		}
		k, v, _ := strings.Cut(p, "=")
		kvs = append(kvs, kv{k: uriEscape(percentDecode(k), true), v: uriEscape(percentDecode(v), true)})
	}
	sort.Slice(kvs, func(i, j int) bool {
		if kvs[i].k == kvs[j].k {
			return kvs[i].v < kvs[j].v
		}
		return kvs[i].k < kvs[j].k
	})
	var b strings.Builder
	for i, p := range kvs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(p.k)
		b.WriteByte('=')
		b.WriteString(p.v)
	}
	return b.String()
}

func uriEscape(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '_', c == '-', c == '~', c == '.':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func percentDecode(s string) string {
	out, err := url.QueryUnescape(s)
	if err != nil {
		return s
	}
	return out
}

func deriveSigningKey(secret, date, region, service string) []byte {
	k1 := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	k2 := hmacSHA256(k1, []byte(region))
	k3 := hmacSHA256(k2, []byte(service))
	return hmacSHA256(k3, []byte("aws4_request"))
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func hexSha256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// signRequest signs `req` in-place with the upstream real-R2 credentials.
// `contentSha` is the payload hash that will be presented in the
// x-amz-content-sha256 header; pass "UNSIGNED-PAYLOAD" for streaming bodies.
func signRequest(req *http.Request, ak, sk, region, service, contentSha string) {
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateOnly := now.Format("20060102")

	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", contentSha)
	req.Header.Set("Host", req.Host)

	// Collect signed headers: host, x-amz-date, x-amz-content-sha256, and any x-amz-* the caller set.
	signed := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	for k := range req.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-") && lk != "x-amz-date" && lk != "x-amz-content-sha256" {
			signed = append(signed, lk)
		}
		if lk == "content-type" || lk == "content-md5" {
			signed = append(signed, lk)
		}
	}
	sort.Strings(signed)
	signed = dedupe(signed)

	cr := canonicalRequest(req, signed, contentSha)
	scope := dateOnly + "/" + region + "/" + service + "/aws4_request"
	sts := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hexSha256([]byte(cr)),
	}, "\n")
	key := deriveSigningKey(sk, dateOnly, region, service)
	sig := hex.EncodeToString(hmacSHA256(key, []byte(sts)))

	auth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		ak, scope, strings.Join(signed, ";"), sig)
	req.Header.Set("Authorization", auth)
}

func dedupe(in []string) []string {
	seen := map[string]struct{}{}
	out := in[:0]
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

type deleteObjectsBody struct {
	Objects []struct {
		Key string `xml:"Key"`
	} `xml:"Object"`
}

func authorizeBinding(r *http.Request, key string, b Binding, body []byte) (code, msg string, ok bool) {
	code, msg, ok = authorizeOperation(r, key, b.Prefix, body)
	if ok || len(b.ReadPrefixes) == 0 || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return code, msg, ok
	}
	for _, prefix := range b.ReadPrefixes {
		if _, _, readable := authorizeOperation(r, key, prefix, body); readable {
			return "", "", true
		}
	}
	return code, msg, ok
}

func authorizeOperation(r *http.Request, key, prefix string, body []byte) (code, msg string, ok bool) {
	for h := range r.Header {
		if strings.HasPrefix(strings.ToLower(h), "x-amz-copy-source") {
			return "AccessDenied", "copy operations are not permitted", false
		}
	}
	q := r.URL.Query()
	inPrefix := func(k string) bool { return prefix == "" || strings.HasPrefix(k, prefix) }

	if key != "" {
		if !inPrefix(key) {
			return "AccessDenied", "key outside policy prefix", false
		}
		switch r.Method {
		case http.MethodHead, http.MethodGet, http.MethodPut, http.MethodDelete:
			return "", "", true
		case http.MethodPost:
			if q.Has("uploads") || q.Has("uploadId") {
				return "", "", true
			}
		}
		return "MethodNotAllowed", "operation not permitted on objects", false
	}

	switch r.Method {
	case http.MethodHead:
		return "", "", true
	case http.MethodGet:
		if q.Has("location") || q.Has("versioning") || q.Has("lifecycle") || q.Has("policy") ||
			q.Has("acl") || q.Has("cors") || q.Has("logging") || q.Has("encryption") {
			return "", "", true
		}
		if q.Has("uploads") {
			return "AccessDenied", "listing multipart uploads is not permitted", false
		}
		if !inPrefix(q.Get("prefix")) {
			return "AccessDenied", "list prefix outside policy scope", false
		}
		return "", "", true
	case http.MethodPost:
		if !q.Has("delete") {
			return "MethodNotAllowed", "operation not permitted on the bucket", false
		}
		var del deleteObjectsBody
		if err := xml.Unmarshal(body, &del); err != nil {
			return "MalformedXML", "could not parse the delete request", false
		}
		if len(del.Objects) == 0 {
			return "MalformedXML", "delete request names no objects", false
		}
		for _, o := range del.Objects {
			if o.Key == "" || !inPrefix(o.Key) {
				return "AccessDenied", "delete request names a key outside policy prefix", false
			}
		}
		return "", "", true
	}
	return "MethodNotAllowed", "operation not permitted on the bucket", false
}

func splitPathStyle(p string) (bucket, key string) {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return "", ""
	}
	i := strings.IndexByte(p, '/')
	if i < 0 {
		return p, ""
	}
	return p[:i], p[i+1:]
}

type upstreamBody struct {
	reader  io.Reader
	length  int64
	sha     string
	inspect []byte
}

var errBodyTooLarge = errors.New("body too large")

func prepareUpstreamBody(w http.ResponseWriter, r *http.Request, key string) (upstreamBody, error) {
	clientHash := r.Header.Get("x-amz-content-sha256")
	if key != "" && r.ContentLength >= 0 && isForwardablePayloadHash(clientHash) {
		if r.ContentLength > maxBodyBytes {
			return upstreamBody{}, errBodyTooLarge
		}
		if r.ContentLength == 0 {
			return upstreamBody{reader: http.NoBody, sha: clientHash}, nil
		}
		return upstreamBody{
			reader: http.MaxBytesReader(w, r.Body, maxBodyBytes),
			length: r.ContentLength,
			sha:    clientHash,
		}, nil
	}

	limit := int64(maxBodyBytes)
	if key == "" {
		limit = maxControlBodyBytes
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	body, contentSha, err := readBodyForSigning(r)
	if err != nil {
		return upstreamBody{}, err
	}
	return upstreamBody{
		reader:  bytes.NewReader(body),
		length:  int64(len(body)),
		sha:     contentSha,
		inspect: body,
	}, nil
}

func isForwardablePayloadHash(h string) bool {
	if h == "UNSIGNED-PAYLOAD" {
		return true
	}
	if len(h) != sha256.Size*2 {
		return false
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func readBodyForSigning(r *http.Request) (body []byte, contentSha string, err error) {
	body, err = io.ReadAll(r.Body)
	if err != nil {
		return nil, "", err
	}
	return body, hexSha256(body), nil
}

func copyForwardHeaders(in, out http.Header) {
	skip := map[string]bool{
		"Authorization":        true,
		"X-Amz-Date":           true,
		"X-Amz-Content-Sha256": true,
		"X-Amz-Security-Token": true,
		"Host":                 true,
		"Content-Length":       true, // Go sets this automatically from the body
		"Connection":           true,
		"Proxy-Connection":     true,
		"Transfer-Encoding":    true,
		"Upgrade":              true,
		"Te":                   true,
		"Trailer":              true,
		"Keep-Alive":           true,
	}
	for k, v := range in {
		if skip[http.CanonicalHeaderKey(k)] {
			continue
		}
		out[k] = append([]string(nil), v...)
	}
}

func denyAndLog(w http.ResponseWriter, r *http.Request, ak, code, msg string) {
	log.Printf("[r2-proxy] DENY %s %s ak=%s %s: %s", r.Method, r.URL.Path, ak, code, msg)
	s3Error(w, http.StatusForbidden, code, msg)
}

func s3Error(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w,
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>"+
			"<Error><Code>%s</Code><Message>%s</Message></Error>",
		code, msg)
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required env %s is not set", key)
	}
	return v
}
