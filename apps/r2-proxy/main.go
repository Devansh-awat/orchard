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
// Bindings come straight from orchard's Postgres `databases` table — there
// is no ConfigMap to drift from the source of truth. Lookups are cached
// in-memory for 60s on hit, 5s on miss.
//
// Configuration:
//
//	PROXY_LISTEN      address to listen on (default :9000)
//	R2_ENDPOINT       upstream R2 endpoint (https://<acc>.r2.cloudflarestorage.com)
//	R2_REGION         signing region for upstream (default "auto")
//	R2_ACCESS_KEY     real R2 access key id
//	R2_SECRET_KEY     real R2 secret access key
//	DATABASE_URL      postgres URL pointing at orchard's database (read-only role recommended)
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
	"time"

	_ "github.com/lib/pq"
)

// Version is set via -ldflags "-X main.Version=..." at build time.
var Version = "dev"

// ─────────────────────────── binding resolver ───────────────────────────

type Binding struct {
	AccessKey string
	Secret    string
	Bucket    string
	Prefix    string
}

type cacheEntry struct {
	binding   Binding
	found     bool
	expiresAt time.Time
}

const (
	hitTTL  = 60 * time.Second
	missTTL = 5 * time.Second
)

// bindingStore resolves access keys to bindings, backed by orchard's Postgres.
// A small TTL cache absorbs the steady-state load (barman makes many requests
// per backup) while still picking up new databases within ~missTTL of creation.
type bindingStore struct {
	db            *sql.DB
	defaultBucket string

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

func (s *bindingStore) get(ak string) (Binding, bool) {
	now := time.Now()

	s.mu.RLock()
	if hit, ok := s.cache[ak]; ok && hit.expiresAt.After(now) {
		s.mu.RUnlock()
		return hit.binding, hit.found
	}
	s.mu.RUnlock()

	// Cache miss / expired — hit the DB.
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
	err := s.db.QueryRowContext(ctx, q, ak, s.defaultBucket).Scan(&b.AccessKey, &b.Secret, &ns, &cluster, &b.Bucket)
	if errors.Is(err, sql.ErrNoRows) {
		return Binding{}, false, nil
	}
	if err != nil {
		return Binding{}, false, err
	}
	// Trailing slash on the prefix so "ns/db1" doesn't accidentally match "ns/db10/...".
	b.Prefix = ns + "/" + cluster + "/"
	return b, true, nil
}

// ─────────────────────────── proxy ───────────────────────────

type Proxy struct {
	upstreamURL     *url.URL
	upstreamRegion  string
	upstreamAK      string
	upstreamSK      string
	upstreamService string
	policy          *bindingStore
	client          *http.Client
}

func main() {
	log.Printf("r2-proxy version %s", Version)
	listen := envDefault("PROXY_LISTEN", ":9000")
	endpoint := mustEnv("R2_ENDPOINT")
	region := envDefault("R2_REGION", "auto")
	ak := mustEnv("R2_ACCESS_KEY")
	sk := mustEnv("R2_SECRET_KEY")
	dbURL := mustEnv("DATABASE_URL")

	upURL, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil || upURL.Host == "" {
		log.Fatalf("R2_ENDPOINT invalid: %v", err)
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)

	// Eager-ping so we fail fast if creds are wrong, rather than crash on
	// first request. Don't fatally exit though — DB blip during boot
	// shouldn't take the proxy down indefinitely; we'll retry per request.
	{
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := db.PingContext(ctx); err != nil {
			log.Printf("[r2-proxy] db ping failed at boot: %v (will retry per-request)", err)
		}
		cancel()
	}

	store := newBindingStore(db, envDefault("DEFAULT_BACKUP_BUCKET", ""))

	p := &Proxy{
		upstreamURL:     upURL,
		upstreamRegion:  region,
		upstreamAK:      ak,
		upstreamSK:      sk,
		upstreamService: "s3",
		policy:          store,
		// No client-level timeout: backup uploads can be large/long. The
		// caller controls liveness via context (we don't add one — barman
		// has its own retry/timeout). If you front this with an ingress
		// proxy add idle-timeout there.
		client: &http.Client{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/", p)

	log.Printf("[r2-proxy] listening %s, upstream=%s region=%s", listen, upURL, region)
	if err := http.ListenAndServe(listen, mux); err != nil {
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

	// Enforce bucket + prefix. Path-style addressing only — barman uses uri-style=path.
	bucket, key := splitPathStyle(r.URL.Path)
	if bucket == "" {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "missing bucket in path")
		return
	}
	if bucket != binding.Bucket {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "bucket not allowed for this key")
		return
	}
	// Object-level operations must target a key inside the binding's prefix.
	// Bucket-level operations (key=="") get separate handling below.
	if key != "" && binding.Prefix != "" && !strings.HasPrefix(key, binding.Prefix) {
		denyAndLog(w, r, authz.AccessKey, "AccessDenied", "key outside policy prefix")
		return
	}
	if key == "" {
		// Bucket-level: HEAD/GET location/policy/lifecycle/etc. are metadata
		// ops on the bucket itself — bucket check already passed, allow.
		// Listing operations (GET with no sub-resource) must have ?prefix=
		// inside the binding's prefix so the response can't include other
		// tenants' keys.
		if r.Method == http.MethodGet {
			q := r.URL.Query()
			// Treat ?location, ?versioning, ?lifecycle, ?policy, ?acl etc. as
			// metadata sub-resources and allow them through (bucket-level only,
			// no tenant data exposure).
			isMetadataSubresource := q.Has("location") || q.Has("versioning") ||
				q.Has("lifecycle") || q.Has("policy") || q.Has("acl") ||
				q.Has("cors") || q.Has("logging") || q.Has("encryption")
			if !isMetadataSubresource {
				listPrefix := q.Get("prefix")
				if binding.Prefix != "" && !strings.HasPrefix(listPrefix, binding.Prefix) {
					denyAndLog(w, r, authz.AccessKey, "AccessDenied", "list prefix outside policy scope")
					return
				}
			}
		}
	}

	// Build upstream request: same method, same path (preserves bucket+key shape
	// so path-style works), same query, same body. Re-sign with real creds.
	upURL := *p.upstreamURL
	upURL.Path = r.URL.Path
	upURL.RawQuery = r.URL.RawQuery

	body, contentSha, err := readBodyForSigning(r)
	if err != nil {
		s3Error(w, http.StatusInternalServerError, "InternalError", "body read failed")
		return
	}

	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, upURL.String(), bytes.NewReader(body))
	if err != nil {
		s3Error(w, http.StatusInternalServerError, "InternalError", "upstream request build failed")
		return
	}
	// Carry through most headers but strip auth-related ones; we'll add fresh ones.
	copyForwardHeaders(r.Header, outReq.Header)
	outReq.Host = upURL.Host
	outReq.Header.Set("Host", upURL.Host)
	outReq.Header.Set("x-amz-content-sha256", contentSha)
	outReq.Header.Set("x-amz-date", time.Now().UTC().Format("20060102T150405Z"))
	outReq.Header.Del("Authorization")

	signRequest(outReq, p.upstreamAK, p.upstreamSK, p.upstreamRegion, p.upstreamService, contentSha)

	resp, err := p.client.Do(outReq)
	if err != nil {
		log.Printf("[r2-proxy] %s %s ak=%s upstream-error: %v", r.Method, r.URL.Path, authz.AccessKey, err)
		s3Error(w, http.StatusBadGateway, "InternalError", "upstream error")
		return
	}
	defer resp.Body.Close()
	log.Printf("[r2-proxy] %s %s ak=%s → %d", r.Method, r.URL.Path, authz.AccessKey, resp.StatusCode)

	// Stream response back. Don't add or rewrite headers — barman/aws-sdk
	// validates ETag, Content-Length, and the various x-amz-* headers it set.
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

// ─────────────────────────── auth parsing ───────────────────────────

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

// ─────────────────────────── V4 verify ───────────────────────────

// verifyV4 reconstructs the canonical request the client signed and compares
// the resulting signature against what they sent. The payload hash is taken
// at face value from x-amz-content-sha256 (we don't re-hash the body — large
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

// ─────────────────────────── upstream signing ───────────────────────────

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

// ─────────────────────────── helpers ───────────────────────────

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

// readBodyForSigning slurps the request body so we can compute its hash and
// re-send it upstream. Large multipart parts are streamed by the SDK in
// many MB chunks — for v1 we buffer; revisit if memory pressure becomes a
// concern (parts are typically ≤16MB, capped by barman config).
func readBodyForSigning(r *http.Request) (body []byte, contentSha string, err error) {
	// If the client used UNSIGNED-PAYLOAD or streaming, propagate that
	// without re-hashing. We still need to capture the body to forward it,
	// since chunked encoding from a Go server isn't straightforward.
	clientHash := r.Header.Get("x-amz-content-sha256")
	body, err = io.ReadAll(r.Body)
	if err != nil {
		return nil, "", err
	}
	if clientHash == "UNSIGNED-PAYLOAD" || strings.HasPrefix(clientHash, "STREAMING-") {
		// Compute a real hash for the upstream request — R2 doesn't accept
		// streaming signatures the same way every SDK sends them, but it
		// always accepts a literal payload hash.
		return body, hexSha256(body), nil
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
