package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const prefix = "ns-a/cluster-a/"

func request(method, target string, body string, headers map[string]string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestObjectsInsidePrefixAreAllowed(t *testing.T) {
	for _, m := range []string{"GET", "PUT", "HEAD", "DELETE"} {
		if _, _, ok := authorizeOperation(request(m, "/b/ns-a/cluster-a/base/x", "", nil), "ns-a/cluster-a/base/x", prefix, nil); !ok {
			t.Fatalf("%s inside prefix should be allowed", m)
		}
	}
	if _, _, ok := authorizeOperation(request("POST", "/b/ns-a/cluster-a/wal?uploads", "", nil), "ns-a/cluster-a/wal", prefix, nil); !ok {
		t.Fatal("multipart initiate should be allowed")
	}
}

func TestObjectsOutsidePrefixAreRefused(t *testing.T) {
	if _, _, ok := authorizeOperation(request("GET", "/b/ns-b/cluster-b/base/x", "", nil), "ns-b/cluster-b/base/x", prefix, nil); ok {
		t.Fatal("other tenant's key must be refused")
	}
}

func TestCopySourceIsRefusedEvenInsidePrefix(t *testing.T) {
	r := request("PUT", "/b/ns-a/cluster-a/steal", "", map[string]string{"x-amz-copy-source": "/b/ns-b/cluster-b/base/data.tar"})
	if _, _, ok := authorizeOperation(r, "ns-a/cluster-a/steal", prefix, nil); ok {
		t.Fatal("copy from another prefix must be refused")
	}
}

func TestMultiDeleteIsCheckedPerKey(t *testing.T) {
	own := `<Delete><Object><Key>ns-a/cluster-a/wal/1</Key></Object><Object><Key>ns-a/cluster-a/wal/2</Key></Object></Delete>`
	if _, _, ok := authorizeOperation(request("POST", "/b?delete", own, nil), "", prefix, []byte(own)); !ok {
		t.Fatal("deleting own keys should be allowed")
	}
	mixed := `<Delete><Object><Key>ns-a/cluster-a/wal/1</Key></Object><Object><Key>ns-b/cluster-b/base/data.tar</Key></Object></Delete>`
	if _, _, ok := authorizeOperation(request("POST", "/b?delete", mixed, nil), "", prefix, []byte(mixed)); ok {
		t.Fatal("a delete naming another tenant's key must be refused")
	}
}

func TestBucketLevelWritesAreRefused(t *testing.T) {
	for _, tc := range []struct{ method, target string }{
		{"PUT", "/b?lifecycle"},
		{"DELETE", "/b"},
		{"PUT", "/b?policy"},
		{"POST", "/b"},
	} {
		if _, _, ok := authorizeOperation(request(tc.method, tc.target, "", nil), "", prefix, nil); ok {
			t.Fatalf("%s %s must be refused", tc.method, tc.target)
		}
	}
}

func TestListingStaysInsidePrefix(t *testing.T) {
	if _, _, ok := authorizeOperation(request("GET", "/b?list-type=2&prefix=ns-a/cluster-a/base/", "", nil), "", prefix, nil); !ok {
		t.Fatal("listing own prefix should be allowed")
	}
	if _, _, ok := authorizeOperation(request("GET", "/b?list-type=2&prefix=ns-", "", nil), "", prefix, nil); ok {
		t.Fatal("listing a wider prefix must be refused")
	}
	if _, _, ok := authorizeOperation(request("GET", "/b?uploads", "", nil), "", prefix, nil); ok {
		t.Fatal("listing multipart uploads must be refused")
	}
}

func TestRestoreBindingReadsSourceButWritesOnlyItsOwnPrefix(t *testing.T) {
	b := Binding{Prefix: "ns-a/db-rnew/", ReadPrefixes: []string{"ns-a/db/"}}
	allow := func(method, target, key string, body []byte) bool {
		_, _, ok := authorizeBinding(request(method, target, "", nil), key, b, body)
		return ok
	}
	if !allow("GET", "/b/ns-a/db/db/base/x", "ns-a/db/db/base/x", nil) {
		t.Fatal("restore could not read the source backups")
	}
	if !allow("HEAD", "/b/ns-a/db/db/wals/1", "ns-a/db/db/wals/1", nil) {
		t.Fatal("restore could not stat the source wal")
	}
	if !allow("GET", "/b?list-type=2&prefix=ns-a/db/db/base/", "", nil) {
		t.Fatal("restore could not list the source backups")
	}
	if !allow("PUT", "/b/ns-a/db-rnew/db-rnew/wals/1", "ns-a/db-rnew/db-rnew/wals/1", nil) {
		t.Fatal("restore could not archive into its own prefix")
	}
	if allow("PUT", "/b/ns-a/db/db/wals/1", "ns-a/db/db/wals/1", nil) {
		t.Fatal("restore wrote into the source prefix")
	}
	if allow("DELETE", "/b/ns-a/db/db/base/x", "ns-a/db/db/base/x", nil) {
		t.Fatal("restore deleted from the source prefix")
	}
	src := `<Delete><Object><Key>ns-a/db/db/base/x</Key></Object></Delete>`
	if allow("POST", "/b?delete", "", []byte(src)) {
		t.Fatal("restore bulk-deleted from the source prefix")
	}
	if allow("GET", "/b/ns-b/other/base/x", "ns-b/other/base/x", nil) {
		t.Fatal("restore read another database's backups")
	}
}

const (
	testAccessKey   = "test-ak"
	testSecret      = "test-secret"
	upstreamAK      = "real-ak"
	upstreamSK      = "real-sk"
	emptyPayloadSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
)

type upstreamHit struct {
	method      string
	path        string
	query       string
	contentSha  string
	length      int64
	transfer    []string
	bodySha     string
	body        []byte
	signatureOK bool
}

func newProxyWithUpstream(t *testing.T, keepBody bool) (*Proxy, *[]upstreamHit) {
	t.Helper()
	hits := &[]upstreamHit{}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit := upstreamHit{
			method:     r.Method,
			path:       r.URL.Path,
			query:      r.URL.RawQuery,
			contentSha: r.Header.Get("x-amz-content-sha256"),
			length:     r.ContentLength,
			transfer:   r.TransferEncoding,
		}
		if authz, err := parseAuthHeader(r.Header.Get("Authorization")); err == nil {
			hit.signatureOK = authz.AccessKey == upstreamAK && verifyV4(r, authz, upstreamSK) == nil
		}
		h := sha256.New()
		var sink io.Writer = h
		var kept bytes.Buffer
		if keepBody {
			sink = io.MultiWriter(h, &kept)
		}
		if _, err := io.Copy(sink, r.Body); err != nil {
			t.Errorf("upstream read: %v", err)
		}
		hit.bodySha = hex.EncodeToString(h.Sum(nil))
		if keepBody {
			hit.body = kept.Bytes()
		}
		*hits = append(*hits, hit)
		if hit.contentSha != "UNSIGNED-PAYLOAD" && hit.contentSha != hit.bodySha {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("ETag", `"etag"`)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(mock.Close)

	upURL, err := url.Parse(mock.URL)
	if err != nil {
		t.Fatal(err)
	}
	store := newBindingStore(nil)
	store.cache[testAccessKey] = cacheEntry{
		binding:   Binding{AccessKey: testAccessKey, Secret: testSecret, Buckets: backupBuckets, Prefix: prefix},
		found:     true,
		expiresAt: time.Now().Add(time.Hour),
	}
	proxy := &Proxy{
		upstreamService: "s3",
		policy:          store,
		client:          mock.Client(),
	}
	proxy.upstreams.Store(&upstreamTable{
		base:          &upstream{url: upURL, region: "auto", accessKey: upstreamAK, secretKey: upstreamSK, pathStyle: true},
		baseBuckets:   map[string]bool{"b": true},
		defaultBucket: "b",
	})
	return proxy, hits
}

func signedRequest(method, target string, body io.Reader, length int64, contentSha string) *http.Request {
	r := httptest.NewRequest(method, target, body)
	r.ContentLength = length
	signRequest(r, testAccessKey, testSecret, "auto", "s3", contentSha)
	return r
}

type patternReader struct{ remaining int64 }

func (p *patternReader) Read(b []byte) (int, error) {
	if p.remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(b)) > p.remaining {
		b = b[:p.remaining]
	}
	for i := range b {
		b[i] = byte(p.remaining - int64(i))
	}
	p.remaining -= int64(len(b))
	return len(b), nil
}

func patternSha(n int64) string {
	h := sha256.New()
	_, _ = io.Copy(h, &patternReader{remaining: n})
	return hex.EncodeToString(h.Sum(nil))
}

func TestHashedPutStreamsExactBytesWithDeclaredHash(t *testing.T) {
	p, hits := newProxyWithUpstream(t, true)
	body := []byte("wal segment bytes")
	sum := sha256.Sum256(body)
	declared := hex.EncodeToString(sum[:])

	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-a/cluster-a/wals/1", bytes.NewReader(body), int64(len(body)), declared))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if len(*hits) != 1 {
		t.Fatalf("upstream saw %d requests", len(*hits))
	}
	hit := (*hits)[0]
	if !bytes.Equal(hit.body, body) {
		t.Fatalf("upstream body %q", hit.body)
	}
	if hit.contentSha != declared {
		t.Fatalf("upstream payload hash %q, want the declared %q", hit.contentSha, declared)
	}
	if hit.length != int64(len(body)) || len(hit.transfer) != 0 {
		t.Fatalf("upstream length %d transfer %v", hit.length, hit.transfer)
	}
	if !hit.signatureOK {
		t.Fatal("upstream signature did not verify")
	}
}

func TestHashedPutWithTamperedBodyIsRejectedUpstream(t *testing.T) {
	p, hits := newProxyWithUpstream(t, false)
	body := []byte("tampered")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-a/cluster-a/wals/1", bytes.NewReader(body), int64(len(body)), emptyPayloadSha))

	if len(*hits) != 1 || (*hits)[0].contentSha != emptyPayloadSha {
		t.Fatalf("upstream must be handed the declared hash, got %+v", *hits)
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want the upstream integrity rejection", rec.Code)
	}
}

func TestUnsignedPayloadPutStreams(t *testing.T) {
	p, hits := newProxyWithUpstream(t, true)
	body := []byte("base backup part")
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-a/cluster-a/base/x?partNumber=1&uploadId=u", bytes.NewReader(body), int64(len(body)), "UNSIGNED-PAYLOAD"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	hit := (*hits)[0]
	if hit.contentSha != "UNSIGNED-PAYLOAD" || !bytes.Equal(hit.body, body) || !hit.signatureOK {
		t.Fatalf("unexpected upstream request %+v", hit)
	}
	if hit.query != "partNumber=1&uploadId=u" {
		t.Fatalf("upstream query %q", hit.query)
	}
}

func TestEmptyBodyGetStreams(t *testing.T) {
	p, hits := newProxyWithUpstream(t, false)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("GET", "/b/ns-a/cluster-a/base/x", http.NoBody, 0, emptyPayloadSha))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	hit := (*hits)[0]
	if hit.length != 0 || len(hit.transfer) != 0 || !hit.signatureOK {
		t.Fatalf("unexpected upstream request %+v", hit)
	}
}

func TestStreamedPutOutsidePrefixNeverReachesUpstream(t *testing.T) {
	p, hits := newProxyWithUpstream(t, false)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-b/cluster-b/wals/1", strings.NewReader("x"), 1, "UNSIGNED-PAYLOAD"))

	if rec.Code != http.StatusForbidden || len(*hits) != 0 {
		t.Fatalf("status %d, upstream hits %d", rec.Code, len(*hits))
	}
}

func TestOversizedDeclaredLengthIsRefused(t *testing.T) {
	p, hits := newProxyWithUpstream(t, false)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-a/cluster-a/base/x", strings.NewReader(""), maxBodyBytes+1, "UNSIGNED-PAYLOAD"))

	if rec.Code != http.StatusRequestEntityTooLarge || len(*hits) != 0 {
		t.Fatalf("status %d, upstream hits %d", rec.Code, len(*hits))
	}
}

func TestMultiDeleteIsBufferedAndAuthorized(t *testing.T) {
	p, hits := newProxyWithUpstream(t, true)
	own := `<Delete><Object><Key>ns-a/cluster-a/wal/1</Key></Object></Delete>`
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("POST", "/b?delete", strings.NewReader(own), int64(len(own)), "UNSIGNED-PAYLOAD"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	hit := (*hits)[0]
	if string(hit.body) != own || hit.contentSha != hexSha256([]byte(own)) || !hit.signatureOK {
		t.Fatalf("delete was not re-hashed from the buffered body: %+v", hit)
	}

	mixed := `<Delete><Object><Key>ns-a/cluster-a/wal/1</Key></Object><Object><Key>ns-b/cluster-b/base/data.tar</Key></Object></Delete>`
	sum := sha256.Sum256([]byte(mixed))
	rec = httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("POST", "/b?delete", strings.NewReader(mixed), int64(len(mixed)), hex.EncodeToString(sum[:])))

	if rec.Code != http.StatusForbidden || len(*hits) != 1 {
		t.Fatalf("cross-tenant delete: status %d, upstream hits %d", rec.Code, len(*hits))
	}
	if !strings.Contains(rec.Body.String(), "AccessDenied") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestOversizedControlBodyIsRefused(t *testing.T) {
	p, hits := newProxyWithUpstream(t, false)
	n := int64(maxControlBodyBytes + 1)
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("POST", "/b?delete", &patternReader{remaining: n}, n, "UNSIGNED-PAYLOAD"))

	if rec.Code != http.StatusRequestEntityTooLarge || len(*hits) != 0 {
		t.Fatalf("status %d, upstream hits %d", rec.Code, len(*hits))
	}
}

func TestLargeStreamedPutDoesNotBuffer(t *testing.T) {
	const size = 64 << 20
	declared := patternSha(size)
	p, hits := newProxyWithUpstream(t, false)

	warm := httptest.NewRecorder()
	p.ServeHTTP(warm, signedRequest("PUT", "/b/ns-a/cluster-a/base/warm", http.NoBody, 0, emptyPayloadSha))

	req := signedRequest("PUT", "/b/ns-a/cluster-a/base/data.tar", &patternReader{remaining: size}, size, declared)
	rec := httptest.NewRecorder()

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	p.ServeHTTP(rec, req)
	runtime.ReadMemStats(&after)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	hit := (*hits)[len(*hits)-1]
	if hit.bodySha != declared || hit.length != size {
		t.Fatalf("upstream got length %d sha %s", hit.length, hit.bodySha)
	}
	if delta := after.TotalAlloc - before.TotalAlloc; delta > 16<<20 {
		t.Fatalf("proxying %d bytes allocated %d bytes", size, delta)
	}
}

func TestStreamingChunkedPayloadStaysBuffered(t *testing.T) {
	p, hits := newProxyWithUpstream(t, true)
	body := "10;chunk-signature=abc\r\n0123456789abcdef\r\n0;chunk-signature=def\r\n\r\n"
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, signedRequest("PUT", "/b/ns-a/cluster-a/wals/1", strings.NewReader(body), int64(len(body)), "STREAMING-AWS4-HMAC-SHA256-PAYLOAD"))

	hit := (*hits)[0]
	if hit.contentSha != hexSha256([]byte(body)) || string(hit.body) != body {
		t.Fatalf("aws-chunked payload was not buffered and re-hashed: %+v", hit)
	}
}

func TestScopedPrefixesGetATrailingSlash(t *testing.T) {
	if got := withSlash("ns/pg-db"); got != "ns/pg-db/" {
		t.Fatalf("withSlash = %q", got)
	}
	if got := withSlash("ns/pg-db/"); got != "ns/pg-db/" {
		t.Fatalf("withSlash = %q", got)
	}
}

type capturedRequest struct {
	host       string
	path       string
	signatureK string
	verified   bool
}

func storedProxyFixture(t *testing.T) (*Proxy, *[]capturedRequest, *httptest.Server, *url.URL) {
	t.Helper()
	captured := &[]capturedRequest{}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authz, err := parseAuthHeader(r.Header.Get("Authorization"))
		hit := capturedRequest{host: r.Host, path: r.URL.Path}
		if err == nil {
			hit.signatureK = authz.AccessKey
			secret := map[string]string{"local-ak": "local-sk", "s3-ak": "s3-sk"}[authz.AccessKey]
			hit.verified = verifyV4(r, authz, secret) == nil
		}
		*captured = append(*captured, hit)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(mock.Close)
	endpoint, err := url.Parse(mock.URL)
	if err != nil {
		t.Fatal(err)
	}
	store := newBindingStore(nil)
	store.cache[testAccessKey] = cacheEntry{
		binding:   Binding{AccessKey: testAccessKey, Secret: testSecret, Buckets: backupBuckets, Prefix: prefix},
		found:     true,
		expiresAt: time.Now().Add(time.Hour),
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, endpoint.Host)
		},
	}
	proxy := &Proxy{upstreamService: "s3", policy: store, client: &http.Client{Transport: transport}}
	proxy.upstreams.Store(&upstreamTable{
		base:             &upstream{url: endpoint, region: "auto", accessKey: "local-ak", secretKey: "local-sk", pathStyle: true},
		baseBuckets:      map[string]bool{"local": true},
		defaultBucket:    "local",
		envDefaultBucket: "local",
	})
	return proxy, captured, mock, endpoint
}

func storedJSON(endpoint string, pathStyle bool, bucket string) []byte {
	raw, _ := json.Marshal(storedFile{
		DefaultBucket: bucket,
		Targets: []storedTarget{{
			Bucket: bucket, Endpoint: endpoint, Region: "eu-west-1",
			AccessKey: "s3-ak", SecretKey: "s3-sk", PathStyle: &pathStyle,
		}},
	})
	return raw
}

func loadStored(t *testing.T, proxy *Proxy, raw []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "upstreams.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	base := *proxy.upstreams.Load()
	base.stored = nil
	var last []byte
	proxy.reloadStored(path, base, &last)
}

func objectGet(proxy *Proxy, bucket string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, signedRequest(http.MethodGet, "/"+bucket+"/"+prefix+"wal/1", http.NoBody, 0, emptySha))
	return rec
}

const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestExistingDatabaseKeepsItsOldBucketAfterStorageIsAdded(t *testing.T) {
	proxy, captured, mock, _ := storedProxyFixture(t)
	loadStored(t, proxy, storedJSON(mock.URL, true, "new"))

	if rec := objectGet(proxy, "local"); rec.Code != http.StatusOK {
		t.Fatalf("old bucket: status %d", rec.Code)
	}
	if rec := objectGet(proxy, "new"); rec.Code != http.StatusOK {
		t.Fatalf("new bucket: status %d", rec.Code)
	}
	hits := *captured
	if len(hits) != 2 || hits[0].signatureK != "local-ak" || hits[1].signatureK != "s3-ak" {
		t.Fatalf("each bucket must use its own credentials: %+v", hits)
	}
	if !hits[0].verified || !hits[1].verified {
		t.Fatalf("upstream signature did not verify: %+v", hits)
	}
	if got := proxy.upstreams.Load().defaultBucket; got != "new" {
		t.Fatalf("default bucket %q", got)
	}
}

func TestVirtualHostUpstreamMovesTheBucketIntoTheHost(t *testing.T) {
	proxy, captured, mock, endpoint := storedProxyFixture(t)
	loadStored(t, proxy, storedJSON(mock.URL, false, "new"))

	if rec := objectGet(proxy, "new"); rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	hit := (*captured)[0]
	if hit.host != "new."+endpoint.Host || hit.path != "/"+prefix+"wal/1" {
		t.Fatalf("host %q path %q", hit.host, hit.path)
	}
	if !hit.verified {
		t.Fatal("virtual-host signature did not verify")
	}
}

func TestStoredBucketDoesNotWidenTheKeyPrefix(t *testing.T) {
	proxy, captured, mock, _ := storedProxyFixture(t)
	loadStored(t, proxy, storedJSON(mock.URL, true, "new"))

	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, signedRequest(http.MethodGet, "/new/uploads/users/a.png", http.NoBody, 0, emptySha))
	if rec.Code != http.StatusForbidden || len(*captured) != 0 {
		t.Fatalf("status %d, hits %d", rec.Code, len(*captured))
	}
}

func TestUnknownBucketStaysRefused(t *testing.T) {
	proxy, captured, mock, _ := storedProxyFixture(t)
	loadStored(t, proxy, storedJSON(mock.URL, true, "new"))
	for _, bucket := range []string{"someone-else", "org-owned", "LOCAL", "local.evil"} {
		if rec := objectGet(proxy, bucket); rec.Code != http.StatusForbidden {
			t.Fatalf("bucket %q: status %d", bucket, rec.Code)
		}
	}
	if len(*captured) != 0 {
		t.Fatalf("hits %+v", *captured)
	}
}

func TestReloadKeepsLastGoodAndClearsOnlyWhenTheFileIsGone(t *testing.T) {
	proxy, _, mock, _ := storedProxyFixture(t)
	path := filepath.Join(t.TempDir(), "upstreams.json")
	base := *proxy.upstreams.Load()
	var last []byte

	if err := os.WriteFile(path, storedJSON(mock.URL, true, "new"), 0o600); err != nil {
		t.Fatal(err)
	}
	proxy.reloadStored(path, base, &last)
	if proxy.upstreams.Load().forBucket("new") == nil {
		t.Fatal("stored target not loaded")
	}

	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	proxy.reloadStored(path, base, &last)
	if proxy.upstreams.Load().forBucket("new") == nil {
		t.Fatal("a broken file must not drop a working target")
	}

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	proxy.reloadStored(path, base, &last)
	table := proxy.upstreams.Load()
	if table.forBucket("new") != nil || table.defaultBucket != "local" {
		t.Fatalf("removed file left %+v", table)
	}
}

func TestProxyWithNoUpstreamRefusesCleanly(t *testing.T) {
	table := &upstreamTable{}
	if table.forBucket("anything") != nil || table.isPlatform("anything") {
		t.Fatal("an empty table must serve nothing")
	}
}

func allowed(method, target, body string) bool {
	_, _, ok := authorizeOperation(request(method, target, body, nil), "", prefix, []byte(body))
	return ok
}

func TestRealClientRequestsStillPass(t *testing.T) {
	for _, target := range []string{
		"/b?location",
		"/b?location=",
		"/b?versioning",
		"/b?location&x-id=GetBucketLocation",
		"/b?list-type=2&prefix=ns-a/cluster-a/&delimiter=/&encoding-type=url",
		"/b?list-type=2&prefix=ns-a%2Fcluster-a%2Fbase%2F&max-keys=1000&x-id=ListObjectsV2",
		"/b?list-type=2&prefix=ns-a/cluster-a/&continuation-token=abc%3D%3D",
		"/b?prefix=ns-a/cluster-a/&marker=x",
	} {
		if !allowed("GET", target, "") {
			t.Errorf("GET %s should pass", target)
		}
	}
	for _, body := range []string{
		`<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Object><Key>ns-a/cluster-a/wal/1</Key></Object><Quiet>true</Quiet></Delete>`,
		"<Delete>\n  <Quiet>true</Quiet>\n  <Object>\n    <Key>ns-a/cluster-a/wal/1</Key>\n    <VersionId>v1</VersionId>\n  </Object>\n</Delete>\n",
		`<Delete><Object><Key>ns-a/cluster-a/a&amp;b</Key></Object></Delete>`,
	} {
		if !allowed("POST", "/b?delete", body) {
			t.Errorf("delete should pass: %s", body)
		}
	}
	for _, tc := range []struct{ method, target string }{
		{"PUT", "/b/ns-a/cluster-a/base/data?partNumber=1&uploadId=abc"},
		{"POST", "/b/ns-a/cluster-a/base/data?uploads"},
		{"POST", "/b/ns-a/cluster-a/base/data?uploadId=abc"},
		{"GET", "/b/ns-a/cluster-a/base/data?x-id=GetObject"},
		{"HEAD", "/b/ns-a/cluster-a/base/data"},
		{"DELETE", "/b/ns-a/cluster-a/base/data"},
	} {
		key := strings.TrimPrefix(strings.SplitN(tc.target, "?", 2)[0], "/b/")
		if _, _, ok := authorizeOperation(request(tc.method, tc.target, "", nil), key, prefix, nil); !ok {
			t.Errorf("%s %s should pass", tc.method, tc.target)
		}
	}
}

func TestListingsCannotHideBehindParserDifferences(t *testing.T) {
	for _, target := range []string{
		"/b?list-type=2&prefix=ns-a/cluster-a/&prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/&Prefix=",
		"/b?list-type=2&Prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/;prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/&x=1;prefix=",
		"/b?logging&list-type=2&prefix=",
		"/b?location&list-type=2",
		"/b?acl&prefix=",
		"/b?policy&delimiter=/",
	} {
		if allowed("GET", target, "") {
			t.Errorf("GET %s must be refused", target)
		}
	}
}

func TestDeleteBodiesMustHaveOneReading(t *testing.T) {
	for _, body := range []string{
		`<Delete><Object><Key>ns-b/x</Key><Key>ns-a/cluster-a/x</Key></Object></Delete>`,
		`<Delete><Quiet><Object><Key>ns-b/x</Key></Object></Quiet><Object><Key>ns-a/cluster-a/x</Key></Object></Delete>`,
		`<Delete><Object><Key>ns-a/cluster-a/x</Key><Object><Key>ns-b/x</Key></Object></Object></Delete>`,
		`<Delete><Object><Key>ns-a/cluster-a/<!-- c -->x</Key></Object></Delete>`,
		`<Delete><Object><Key>ns-a/cluster-a/../../ns-b/x</Key></Object></Delete>`,
		`<Other><Object><Key>ns-a/cluster-a/x</Key></Object></Other>`,
		`<Delete><Object><Key>ns-a/cluster-a/x</Key></Object></Delete><Delete><Object><Key>ns-b/x</Key></Object></Delete>`,
		`<Delete><Object></Object></Delete>`,
		`<!DOCTYPE d><Delete><Object><Key>ns-a/cluster-a/x</Key></Object></Delete>`,
	} {
		if allowed("POST", "/b?delete", body) {
			t.Errorf("delete must be refused: %s", body)
		}
	}
}

func TestObjectKeysCannotClimbOutOfThePrefix(t *testing.T) {
	key := "ns-a/cluster-a/../../ns-b/secret"
	if _, _, ok := authorizeOperation(request("GET", "/b/"+key, "", nil), key, prefix, nil); ok {
		t.Fatal("a key with dot segments must be refused")
	}
}

func TestEmptyAllowlistServesNoBucketWithPlatformCredentials(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	table := *proxy.upstreams.Load()
	table.baseBuckets = map[string]bool{}
	proxy.upstreams.Store(&table)

	for _, bucket := range []string{"b", "operator-other-bucket", "anything"} {
		if table.forBucket(bucket) != nil || table.isPlatform(bucket) {
			t.Fatalf("empty allowlist served %q", bucket)
		}
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, signedRequest(http.MethodPut, "/"+bucket+"/"+prefix+"planted", strings.NewReader("x"), 1, "UNSIGNED-PAYLOAD"))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("bucket %q: status %d", bucket, rec.Code)
		}
		rec = httptest.NewRecorder()
		proxy.ServeHTTP(rec, signedRequest(http.MethodGet, "/"+bucket+"?policy", http.NoBody, 0, emptySha))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("bucket %q policy: status %d", bucket, rec.Code)
		}
	}
	if len(*hits) != 0 {
		t.Fatalf("upstream was reached: %+v", *hits)
	}
}

func TestAllowlistParsing(t *testing.T) {
	if len(parseAllowedBuckets("")) != 0 || len(parseAllowedBuckets(" , ,")) != 0 {
		t.Fatal("blank allowlist must stay empty")
	}
	got := parseAllowedBuckets("a, b ,,c")
	if len(got) != 3 || !got["a"] || !got["b"] || !got["c"] {
		t.Fatalf("got %v", got)
	}
}

func TestPrefixesFromTheDatabaseMustBeWellFormed(t *testing.T) {
	for _, p := range []string{"ns/db/", "_drills/op1/"} {
		if !validPrefix(p) {
			t.Errorf("%q should be valid", p)
		}
	}
	for _, p := range []string{"", "/", "ns/db", "/ns/db/", "ns//db/", "ns/../db/", "./", "ns/\x00/"} {
		if validPrefix(p) {
			t.Errorf("%q should be invalid", p)
		}
	}
}

func serve(proxy *Proxy, method, target string, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.ContentLength = int64(len(body))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	sha := "UNSIGNED-PAYLOAD"
	if body == "" {
		sha = emptySha
	}
	signRequest(r, testAccessKey, testSecret, "auto", "s3", sha)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, r)
	return rec
}

func TestFragmentCannotTruncateTheForwardedQuery(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	for _, target := range []string{
		"/b?list-type=2#&prefix=ns-a/cluster-a/",
		"/b?#&prefix=ns-a/cluster-a/",
		"/b?versions#&prefix=ns-a/cluster-a/",
		"/b?uploads#&prefix=ns-a/cluster-a/",
		"/b?list-type=2&prefix=ns-a/cluster-a/#",
		"/b/ns-a/cluster-a/obj#frag",
	} {
		rec := serve(proxy, "GET", target, "", nil)
		if rec.Code == http.StatusOK {
			t.Errorf("GET %s reached upstream", target)
		}
	}
	if len(*hits) != 0 {
		t.Fatalf("upstream was reached: %+v", *hits)
	}
}

func TestEveryAcceptedRequestIsForwardedAsAuthorizedAndSignedAsSent(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	for _, tc := range []struct{ method, target, wantPath, wantQuery string }{
		{"GET", "/b?list-type=2&prefix=ns-a/cluster-a/&delimiter=/", "/b", "list-type=2&prefix=ns-a/cluster-a/&delimiter=/"},
		{"GET", "/b?list-type=2&prefix=ns-a%2Fcluster-a%2F", "/b", "list-type=2&prefix=ns-a%2Fcluster-a%2F"},
		{"GET", "/b/ns-a/cluster-a/a%20b", "/b/ns-a/cluster-a/a b", ""},
		{"GET", "/b/ns-a/cluster-a/a%2Bb", "/b/ns-a/cluster-a/a+b", ""},
		{"GET", "/b/ns-a/cluster-a/%252e%252e/x", "/b/ns-a/cluster-a/%2e%2e/x", ""},
		{"GET", "/b/ns-a/cluster-a/a%23b", "/b/ns-a/cluster-a/a#b", ""},
		{"PUT", "/b/ns-a/cluster-a/p?partNumber=1&uploadId=abc", "/b/ns-a/cluster-a/p", "partNumber=1&uploadId=abc"},
	} {
		before := len(*hits)
		body := ""
		if tc.method == "PUT" {
			body = "x"
		}
		rec := serve(proxy, tc.method, tc.target, body, nil)
		if rec.Code != http.StatusOK || len(*hits) != before+1 {
			t.Errorf("%s %s: status %d", tc.method, tc.target, rec.Code)
			continue
		}
		h := (*hits)[before]
		if h.path != tc.wantPath || h.query != tc.wantQuery || !h.signatureOK {
			t.Errorf("%s %s: upstream saw path %q query %q signed %v", tc.method, tc.target, h.path, h.query, h.signatureOK)
		}
	}
}

func TestTargetsTwoParsersCouldReadDifferentlyAreRefused(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	for _, target := range []string{
		"/b/ns-a/cluster-a/../../ns-b/x",
		"/b/ns-a/cluster-a/%2e%2e/%2e%2e/ns-b/x",
		"/b/ns-a/cluster-a/%2E%2E%2Fns-b/x",
		"/b/ns-a/cluster-a/./x",
		"/b//ns-a/cluster-a/x",
		"/b/ns-a//cluster-a/x",
		"//b/ns-a/cluster-a/x",
		"/b/ns-a/cluster-a/x%5Cy",
		"/b/ns-a/cluster-a/x%00",
		"/b/ns-a/cluster-a/x%0d%0ay",
		"/b/..%2Fns-b/x",
		"/b?list-type=2&prefix=ns-a/cluster-a/;prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/&prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/&Prefix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/&pre%66ix=",
		"/b?list-type=2&prefix=ns-a/cluster-a/+",
		"/b?list-type=2&prefix=ns-a/cluster-a/%zz",
		"/b?list-type=2&prefix=ns-a/cluster-a/&=x",
		"/b?list-type=2&prefix=ns-a/cluster-a/%00",
	} {
		rec := serve(proxy, "GET", target, "", nil)
		if rec.Code == http.StatusOK {
			t.Errorf("GET %s must be refused", target)
		}
	}
	if len(*hits) != 0 {
		t.Fatalf("upstream was reached: %+v", *hits)
	}
}

func TestAbsoluteFormTargetsAreRefused(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	r := httptest.NewRequest("GET", "/b/ns-a/cluster-a/x", http.NoBody)
	r.RequestURI = "http://other.example/b/ns-a/cluster-a/x"
	signRequest(r, testAccessKey, testSecret, "auto", "s3", emptySha)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, r)
	if rec.Code == http.StatusOK || len(*hits) != 0 {
		t.Fatalf("status %d hits %d", rec.Code, len(*hits))
	}
}

func TestOnlyTheOperationsBackupClientsNeedAreAllowed(t *testing.T) {
	obj := "/b/ns-a/cluster-a/base/x"
	for _, tc := range []struct{ method, target string }{
		{"GET", "/b?versions&prefix=ns-a/cluster-a/"},
		{"GET", "/b?uploads&prefix=ns-a/cluster-a/"},
		{"GET", "/b?list-type=2&prefix=ns-a/cluster-a/&versions"},
		{"GET", "/b?list-type=2&prefix=ns-a/cluster-a/&key-marker=x"},
		{"GET", "/b?tagging"},
		{"GET", "/b?policy"},
		{"GET", "/b?acl"},
		{"GET", "/b?cors"},
		{"GET", "/b?lifecycle"},
		{"GET", "/b?logging"},
		{"GET", "/b?encryption"},
		{"GET", "/b?inventory"},
		{"GET", "/b?analytics"},
		{"GET", "/b?metrics"},
		{"GET", "/b?website"},
		{"GET", "/b?object-lock"},
		{"GET", "/b?location&prefix=ns-a/cluster-a/"},
		{"GET", obj + "?acl"},
		{"GET", obj + "?tagging"},
		{"GET", obj + "?torrent"},
		{"GET", obj + "?attributes"},
		{"GET", obj + "?versionId=1"},
		{"GET", obj + "?select&select-type=2"},
		{"GET", obj + "?response-content-disposition=x"},
		{"PUT", obj + "?acl"},
		{"PUT", obj + "?tagging"},
		{"PUT", obj + "?retention"},
		{"PUT", obj + "?legal-hold"},
		{"PUT", obj + "?uploadId=abc"},
		{"PUT", obj + "?partNumber=1"},
		{"PUT", obj + "?partNumber=0&uploadId=abc"},
		{"PUT", obj + "?partNumber=10001&uploadId=abc"},
		{"PUT", obj + "?partNumber=01&uploadId=abc"},
		{"PUT", obj + "?partNumber=1&uploadId=abc&acl"},
		{"POST", obj + "?select&select-type=2"},
		{"POST", obj + "?restore"},
		{"POST", obj},
		{"POST", obj + "?uploads&acl"},
		{"POST", obj + "?uploads&uploadId=abc"},
		{"DELETE", obj + "?versionId=1"},
		{"DELETE", obj + "?tagging"},
		{"PATCH", obj},
		{"OPTIONS", obj},
		{"POST", "/b?delete&versions"},
		{"POST", "/b?restore"},
		{"HEAD", "/b?versions"},
		{"HEAD", obj + "?versionId=1"},
	} {
		key := ""
		if strings.HasPrefix(tc.target, "/b/") {
			key = strings.TrimPrefix(strings.SplitN(tc.target, "?", 2)[0], "/b/")
		}
		body := `<Delete><Object><Key>ns-a/cluster-a/x</Key></Object></Delete>`
		if _, _, ok := authorizeOperation(request(tc.method, tc.target, body, nil), key, prefix, []byte(body)); ok {
			t.Errorf("%s %s must be refused", tc.method, tc.target)
		}
	}
}

func TestAmzHeadersThatNameOrChangeObjectsAreRefused(t *testing.T) {
	obj := "/b/ns-a/cluster-a/base/x"
	key := "ns-a/cluster-a/base/x"
	for _, h := range []string{
		"x-amz-copy-source",
		"X-Amz-Copy-Source",
		"x-amz-copy-source-range",
		"x-amz-copy-source-if-match",
		"x-amz-copy-source-server-side-encryption-customer-key",
		"x_amz_copy_source",
		"x-amz-acl",
		"x-amz-grant-read",
		"x-amz-grant-full-control",
		"x-amz-website-redirect-location",
		"x-amz-object-lock-mode",
		"x-amz-object-lock-legal-hold",
		"x-amz-bypass-governance-retention",
		"x-amz-metadata-directive",
		"x-amz-tagging-directive",
		"x-amz-server-side-encryption-aws-kms-key-id",
		"x-amz-mfa",
		"x-amz-unknown-future-header",
	} {
		for _, m := range []string{"PUT", "GET", "POST", "DELETE"} {
			target := obj
			if m == "POST" {
				target += "?uploads"
			}
			if _, _, ok := authorizeOperation(request(m, target, "", map[string]string{h: "/b/ns-b/cluster-b/base/data.tar"}), key, prefix, nil); ok {
				t.Errorf("%s with header %s must be refused", m, h)
			}
		}
	}
	for _, h := range []string{
		"x-amz-content-sha256", "x-amz-date", "x-amz-meta-anything", "x-amz-checksum-crc32",
		"x-amz-sdk-checksum-algorithm", "x-amz-storage-class", "x-amz-server-side-encryption",
		"x-amz-decoded-content-length", "x-amz-tagging", "x-amz-user-agent",
	} {
		if _, _, ok := authorizeOperation(request("PUT", obj, "", map[string]string{h: "v"}), key, prefix, nil); !ok {
			t.Errorf("header %s should be allowed", h)
		}
	}
}

func TestUploadPartCopyIsRefusedEndToEnd(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	rec := serve(proxy, "PUT", "/b/ns-a/cluster-a/p?partNumber=1&uploadId=abc", "", map[string]string{
		"x-amz-copy-source":       "/b/ns-b/cluster-b/base/data.tar",
		"x-amz-copy-source-range": "bytes=0-9",
	})
	if rec.Code == http.StatusOK || len(*hits) != 0 {
		t.Fatalf("status %d hits %d", rec.Code, len(*hits))
	}
}

func TestHostHeaderAndVirtualHostedAddressingDoNotChangeTheBucket(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	for _, host := range []string{"other-bucket.s3.example.com", "b.localhost", "evil.example.com"} {
		r := httptest.NewRequest("GET", "/b/ns-a/cluster-a/x", http.NoBody)
		r.Host = host
		signRequest(r, testAccessKey, testSecret, "auto", "s3", emptySha)
		rec := httptest.NewRecorder()
		proxy.ServeHTTP(rec, r)
		if rec.Code != http.StatusOK {
			t.Fatalf("host %q: status %d", host, rec.Code)
		}
	}
	for _, h := range *hits {
		if h.path != "/b/ns-a/cluster-a/x" || !h.signatureOK {
			t.Fatalf("upstream saw %+v", h)
		}
	}
	rec := serve(proxy, "GET", "/other/ns-a/cluster-a/x", "", nil)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("a bucket from the path that is not served: status %d", rec.Code)
	}
}

func TestListingsOutsideThePrefixAreRefusedEndToEnd(t *testing.T) {
	proxy, hits := newProxyWithUpstream(t, false)
	for _, target := range []string{
		"/b?list-type=2",
		"/b",
		"/b/",
		"/b?list-type=2&prefix=",
		"/b?list-type=2&prefix=ns-b/",
		"/b?list-type=2&prefix=ns-a/",
		"/b?list-type=2&prefix=ns-a/cluster-a",
		"/b?list-type=2&delimiter=/",
	} {
		if rec := serve(proxy, "GET", target, "", nil); rec.Code == http.StatusOK {
			t.Errorf("GET %s must be refused", target)
		}
	}
	if len(*hits) != 0 {
		t.Fatalf("upstream was reached: %+v", *hits)
	}
}

func TestVirtualHostedUpstreamForwardsTheSameBytesItSigned(t *testing.T) {
	proxy, captured, mock, endpoint := storedProxyFixture(t)
	loadStored(t, proxy, storedJSON(mock.URL, false, "new"))
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, signedRequest(http.MethodGet, "/new?list-type=2&prefix=ns-a/cluster-a/", http.NoBody, 0, emptySha))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	hit := (*captured)[0]
	if hit.host != "new."+endpoint.Host || !hit.verified {
		t.Fatalf("host %q verified %v", hit.host, hit.verified)
	}
}

type bucketHits struct{ buckets []string }

func bucketBoundProxy(t *testing.T, binding Binding, table upstreamTable, storedBuckets ...string) (*Proxy, *bucketHits) {
	t.Helper()
	hits := &bucketHits{}
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bucket, _ := splitPathStyle(r.URL.Path)
		hits.buckets = append(hits.buckets, bucket)
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(mock.Close)
	upURL, err := url.Parse(mock.URL)
	if err != nil {
		t.Fatal(err)
	}
	up := &upstream{url: upURL, region: "auto", accessKey: upstreamAK, secretKey: upstreamSK, pathStyle: true}
	table.base = up
	table.stored = map[string]*upstream{}
	for _, b := range storedBuckets {
		table.stored[b] = up
	}
	binding.AccessKey, binding.Secret = testAccessKey, testSecret
	store := newBindingStore(nil)
	store.cache[testAccessKey] = cacheEntry{binding: binding, found: true, expiresAt: time.Now().Add(time.Hour)}
	proxy := &Proxy{upstreamService: "s3", policy: store, client: mock.Client()}
	proxy.upstreams.Store(&table)
	return proxy, hits
}

type s3Call struct{ name, method, target, body string }

func everyOperation(bucket, p string) []s3Call {
	object := "/" + bucket + "/" + p + "base/x"
	return []s3Call{
		{"head bucket", "HEAD", "/" + bucket, ""},
		{"head object", "HEAD", object, ""},
		{"get object", "GET", object, ""},
		{"put object", "PUT", object, "x"},
		{"delete object", "DELETE", object, ""},
		{"list v2", "GET", "/" + bucket + "?list-type=2&prefix=" + p, ""},
		{"list v1", "GET", "/" + bucket + "?prefix=" + p, ""},
		{"multipart initiate", "POST", object + "?uploads", ""},
		{"multipart upload part", "PUT", object + "?partNumber=1&uploadId=u", "x"},
		{"multipart list parts", "GET", object + "?uploadId=u", ""},
		{"multipart complete", "POST", object + "?uploadId=u", "<CompleteMultipartUpload/>"},
		{"multipart abort", "DELETE", object + "?uploadId=u", ""},
		{"multi-delete", "POST", "/" + bucket + "?delete", "<Delete><Object><Key>" + p + "wal/1</Key></Object></Delete>"},
	}
}

func assertBuckets(t *testing.T, proxy *Proxy, hits *bucketHits, p string, own, others []string) {
	t.Helper()
	for _, bucket := range own {
		for _, op := range everyOperation(bucket, p) {
			before := len(hits.buckets)
			rec := serve(proxy, op.method, op.target, op.body, nil)
			if rec.Code != http.StatusOK || len(hits.buckets) != before+1 || hits.buckets[before] != bucket {
				t.Errorf("%s on its own bucket %q: status %d, upstream %v", op.name, bucket, rec.Code, hits.buckets[before:])
			}
		}
	}
	for _, bucket := range others {
		for _, op := range everyOperation(bucket, p) {
			before := len(hits.buckets)
			rec := serve(proxy, op.method, op.target, op.body, nil)
			if rec.Code != http.StatusForbidden || len(hits.buckets) != before {
				t.Errorf("%s on bucket %q: status %d, upstream %v", op.name, bucket, rec.Code, hits.buckets[before:])
			}
		}
	}
}

func boundTable() upstreamTable {
	return upstreamTable{
		baseBuckets:      map[string]bool{"backups": true, "cache": true, "dumps": true},
		defaultBucket:    "backups",
		envDefaultBucket: "backups",
		cacheBucket:      "cache",
	}
}

func TestDatabaseKeysAreRefusedOnEveryOtherBucket(t *testing.T) {
	proxy, hits := bucketBoundProxy(t, Binding{Buckets: backupBuckets, Prefix: prefix}, boundTable())
	assertBuckets(t, proxy, hits, prefix, []string{"backups"}, []string{"cache", "dumps"})
}

func TestBuildCacheKeysAreRefusedOnEveryOtherBucket(t *testing.T) {
	cache := "_build-cache/proj-a/"
	proxy, hits := bucketBoundProxy(t, Binding{Buckets: buildCacheBucket, Prefix: cache}, boundTable())
	assertBuckets(t, proxy, hits, cache, []string{"cache"}, []string{"backups", "dumps"})
}

func TestRestoreKeysReadTheSourceOnlyInBackupBuckets(t *testing.T) {
	b := Binding{Buckets: backupBuckets, Prefix: "ns-a/db-rnew/", ReadPrefixes: []string{"ns-a/db/"}}
	proxy, hits := bucketBoundProxy(t, b, boundTable(), "old")
	assertBuckets(t, proxy, hits, "ns-a/db-rnew/", []string{"backups", "old"}, []string{"cache", "dumps"})
	for _, bucket := range []string{"backups", "old"} {
		if rec := serve(proxy, "GET", "/"+bucket+"/ns-a/db/base/x", "", nil); rec.Code != http.StatusOK {
			t.Errorf("source read in %q: status %d", bucket, rec.Code)
		}
	}
	before := len(hits.buckets)
	for _, target := range []string{"/cache/ns-a/db/base/x", "/dumps/ns-a/db/base/x", "/cache?list-type=2&prefix=ns-a/db/"} {
		if rec := serve(proxy, "GET", target, "", nil); rec.Code != http.StatusForbidden {
			t.Errorf("GET %s: status %d", target, rec.Code)
		}
	}
	if len(hits.buckets) != before {
		t.Fatalf("upstream was reached: %v", hits.buckets[before:])
	}
}

func TestDatabaseKeysFollowEveryBackupBucketTheServerStored(t *testing.T) {
	table := upstreamTable{
		baseBuckets:      map[string]bool{"local": true, "cache": true},
		defaultBucket:    "new",
		envDefaultBucket: "local",
	}
	proxy, hits := bucketBoundProxy(t, Binding{Buckets: backupBuckets, Prefix: prefix}, table, "new", "old")
	assertBuckets(t, proxy, hits, prefix, []string{"new", "old", "local"}, []string{"cache"})
}

func TestBuildCacheKeysWithoutACacheBucketUseTheDefaultOrAnAllowlistOnlyBucket(t *testing.T) {
	table := upstreamTable{
		baseBuckets:      map[string]bool{"local": true, "cache": true},
		defaultBucket:    "new",
		envDefaultBucket: "local",
	}
	cache := "_build-cache/proj-a/"
	proxy, hits := bucketBoundProxy(t, Binding{Buckets: buildCacheBucket, Prefix: cache}, table, "new", "old")
	assertBuckets(t, proxy, hits, cache, []string{"new", "cache"}, []string{"local", "old"})
}

func TestWithoutADefaultBucketDatabaseKeysKeepTheAllowlist(t *testing.T) {
	table := upstreamTable{baseBuckets: map[string]bool{"a": true, "b": true}}
	proxy, hits := bucketBoundProxy(t, Binding{Buckets: backupBuckets, Prefix: prefix}, table)
	assertBuckets(t, proxy, hits, prefix, []string{"a", "b"}, []string{"c"})
}

func TestKeysThatNameNoBucketAreRefusedEverywhere(t *testing.T) {
	proxy, hits := bucketBoundProxy(t, Binding{Prefix: prefix}, boundTable())
	assertBuckets(t, proxy, hits, prefix, nil, []string{"backups", "cache", "dumps"})
}

func TestScopedKeyPurposesNameTheirBuckets(t *testing.T) {
	for purpose, want := range map[string]bucketScope{
		"build-cache":       buildCacheBucket,
		"database-fork":     backupBuckets,
		"database-restore":  backupBuckets,
		"database-drill":    backupBuckets,
		"database-undelete": backupBuckets,
		"database-purge":    backupBuckets,
		"":                  noBuckets,
		"Build-Cache":       noBuckets,
		"databases":         noBuckets,
		"uploads":           noBuckets,
	} {
		if got := scopeForPurpose(purpose); got != want {
			t.Errorf("purpose %q: scope %d, want %d", purpose, got, want)
		}
	}
}
