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
// Configuration:
//   PROXY_LISTEN      address to listen on (default :9000)
//   R2_ENDPOINT       upstream R2 endpoint (https://<acc>.r2.cloudflarestorage.com)
//   R2_REGION         signing region for upstream (default "auto")
//   R2_ACCESS_KEY     real R2 access key id
//   R2_SECRET_KEY     real R2 secret access key
//   POLICY_PATH       path to JSON policy file (default /etc/r2-proxy/policy.json)
//
// Policy file format (hot-reloaded on file mtime change):
//   {
//     "bindings": [
//       {"accessKey":"orch-abc","secret":"...","bucket":"my-r2","prefix":"ns-foo/cluster-bar/"}
//     ]
//   }
//
// Only the subset of S3 that barman/CNPG actually uses is supported:
// HEAD bucket, HEAD/PUT/GET/DELETE object, LIST objects v1/v2,
// initiate/upload-part/complete/abort multipart upload. Requests must use
// path-style addressing (bucket in the URL path, not the host).
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
)

// ─────────────────────────── policy ───────────────────────────

type Binding struct {
	AccessKey string `json:"accessKey"`
	Secret    string `json:"secret"`
	Bucket    string `json:"bucket"`
	Prefix    string `json:"prefix"`
}

type Policy struct {
	Bindings []Binding `json:"bindings"`
}

type policyStore struct {
	mu        sync.RWMutex
	byAK      map[string]Binding
	loadedMod time.Time
}

func (s *policyStore) get(ak string) (Binding, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.byAK[ak]
	return b, ok
}

func (s *policyStore) load(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat policy: %w", err)
	}
	if !st.ModTime().After(s.loadedMod) {
		return nil // unchanged
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read policy: %w", err)
	}
	var p Policy
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("parse policy: %w", err)
	}
	idx := make(map[string]Binding, len(p.Bindings))
	for _, b := range p.Bindings {
		if b.AccessKey == "" || b.Secret == "" || b.Bucket == "" {
			continue
		}
		// Force trailing slash on prefix so "ns-a/db1" doesn't match "ns-a/db10/...".
		if !strings.HasSuffix(b.Prefix, "/") && b.Prefix != "" {
			b.Prefix = b.Prefix + "/"
		}
		idx[b.AccessKey] = b
	}
	s.mu.Lock()
	s.byAK = idx
	s.loadedMod = st.ModTime()
	s.mu.Unlock()
	log.Printf("[r2-proxy] policy reloaded: %d bindings", len(idx))
	return nil
}

// ─────────────────────────── proxy ───────────────────────────

type Proxy struct {
	upstreamURL      *url.URL
	upstreamRegion   string
	upstreamAK       string
	upstreamSK       string
	upstreamService  string
	policy           *policyStore
	client           *http.Client
}

func main() {
	listen := envDefault("PROXY_LISTEN", ":9000")
	endpoint := mustEnv("R2_ENDPOINT")
	region := envDefault("R2_REGION", "auto")
	ak := mustEnv("R2_ACCESS_KEY")
	sk := mustEnv("R2_SECRET_KEY")
	policyPath := envDefault("POLICY_PATH", "/etc/r2-proxy/policy.json")

	upURL, err := url.Parse(strings.TrimRight(endpoint, "/"))
	if err != nil || upURL.Host == "" {
		log.Fatalf("R2_ENDPOINT invalid: %v", err)
	}

	store := &policyStore{byAK: map[string]Binding{}}
	if err := store.load(policyPath); err != nil {
		// Tolerate missing policy file at boot; bindings can be added later.
		log.Printf("[r2-proxy] initial policy load: %v (continuing)", err)
	}
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			if err := store.load(policyPath); err != nil {
				log.Printf("[r2-proxy] policy reload: %v", err)
			}
		}
	}()

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
		s3Error(w, http.StatusForbidden, "AccessDenied", err.Error())
		return
	}

	binding, ok := p.policy.get(authz.AccessKey)
	if !ok {
		s3Error(w, http.StatusForbidden, "InvalidAccessKeyId", "unknown access key")
		return
	}

	// Verify the V4 signature against the stored secret.
	if err := verifyV4(r, authz, binding.Secret); err != nil {
		s3Error(w, http.StatusForbidden, "SignatureDoesNotMatch", err.Error())
		return
	}

	// Enforce bucket + prefix. Path-style addressing only — barman uses uri-style=path.
	bucket, key := splitPathStyle(r.URL.Path)
	if bucket == "" {
		s3Error(w, http.StatusForbidden, "AccessDenied", "missing bucket in path")
		return
	}
	if bucket != binding.Bucket {
		s3Error(w, http.StatusForbidden, "AccessDenied", "bucket not allowed for this key")
		return
	}
	if binding.Prefix != "" && !strings.HasPrefix(key, binding.Prefix) {
		// List operations target the bucket itself with prefix= in the query string.
		// Ensure that prefix= (if present) is inside the binding's prefix scope.
		if key == "" && r.Method == http.MethodGet {
			q := r.URL.Query()
			listPrefix := q.Get("prefix")
			if !strings.HasPrefix(listPrefix, binding.Prefix) {
				s3Error(w, http.StatusForbidden, "AccessDenied", "list prefix outside policy scope")
				return
			}
		} else {
			s3Error(w, http.StatusForbidden, "AccessDenied", "key outside policy prefix")
			return
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
		log.Printf("[r2-proxy] upstream error: %v", err)
		s3Error(w, http.StatusBadGateway, "InternalError", "upstream error")
		return
	}
	defer resp.Body.Close()

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
		"Authorization":          true,
		"X-Amz-Date":             true,
		"X-Amz-Content-Sha256":   true,
		"X-Amz-Security-Token":   true,
		"Host":                   true,
		"Content-Length":         true, // Go sets this automatically from the body
		"Connection":             true,
		"Proxy-Connection":       true,
		"Transfer-Encoding":      true,
		"Upgrade":                true,
		"Te":                     true,
		"Trailer":                true,
		"Keep-Alive":             true,
	}
	for k, v := range in {
		if skip[http.CanonicalHeaderKey(k)] {
			continue
		}
		out[k] = append([]string(nil), v...)
	}
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
