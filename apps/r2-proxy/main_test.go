package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	t.Cleanup(upstream.Close)

	upURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	store := newBindingStore(nil, "b")
	store.cache[testAccessKey] = cacheEntry{
		binding:   Binding{AccessKey: testAccessKey, Secret: testSecret, Bucket: "b", Prefix: prefix},
		found:     true,
		expiresAt: time.Now().Add(time.Hour),
	}
	return &Proxy{
		upstreamURL:     upURL,
		upstreamRegion:  "auto",
		upstreamAK:      upstreamAK,
		upstreamSK:      upstreamSK,
		upstreamService: "s3",
		policy:          store,
		allowedBuckets:  map[string]bool{"b": true},
		client:          upstream.Client(),
	}, hits
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
