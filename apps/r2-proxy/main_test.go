package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
