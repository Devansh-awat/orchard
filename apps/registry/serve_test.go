package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNormalizeBasePath(t *testing.T) {
	good := map[string]string{"": "", "/": "", "/registry": "/registry", "/registry/": "/registry", "/a/b-c_d.e": "/a/b-c_d.e"}
	for in, want := range good {
		got, err := normalizeBasePath(in)
		if err != nil || got != want {
			t.Fatalf("%q: got %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"//evil.example", "registry", "/a/../b", "/a/./b", "/a b", "/a?x=1", "/a#f", "/a\\b", "https://evil.example", "/a//b", "/a\nb"} {
		if got, err := normalizeBasePath(in); err == nil {
			t.Fatalf("%q should be rejected, got %q", in, got)
		}
	}
}

func TestLatestRedirectUsesConfiguredBasePath(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	fake.objects["templates/ghost/index.json"] = fakeObject{body: []byte(`{"latest":"1.0.0"}`), contentType: "application/json"}
	s := newServer(bucket, "")
	s.basePath = "/registry"
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/templates/ghost/latest/template.yaml", nil)
	req.Header.Set("X-Forwarded-Prefix", "//evil.example")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/registry/templates/ghost/1.0.0/template.yaml" {
		t.Fatalf("%d %q", rec.Code, rec.Header().Get("Location"))
	}
	if rec.Header().Get("Cache-Control") != cacheIndex {
		t.Fatalf("cache-control %q", rec.Header().Get("Cache-Control"))
	}
}

func TestLatestRedirectRefusesHostileIndexVersion(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	fake.objects["templates/ghost/index.json"] = fakeObject{body: []byte(`{"latest":"../../evil"}`), contentType: "application/json"}
	rec := httptest.NewRecorder()
	newServer(bucket, "").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/templates/ghost/latest/template.yaml", nil))
	if rec.Code != http.StatusBadGateway || rec.Header().Get("Location") != "" {
		t.Fatalf("%d %q", rec.Code, rec.Header().Get("Location"))
	}
}
