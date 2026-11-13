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

func TestEveryResponseCarriesNosniffAndCSP(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	fake.objects["templates/ghost/1.0.0/icon.svg"] = fakeObject{body: []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), contentType: "image/svg+xml"}
	fake.objects["templates/ghost/1.0.0/template.yaml"] = fakeObject{body: []byte("kind: Template\n"), contentType: "application/yaml"}
	fake.objects["grafts/forum/1.0.0/forum.graft"] = fakeObject{body: []byte("tarball"), contentType: "application/gzip"}
	fake.objects["templates/index.json"] = fakeObject{body: []byte(`{"templates":[]}`), contentType: "application/json"}
	s := newServer(bucket, "")
	cases := []struct {
		path        string
		range_      string
		disposition string
	}{
		{"/templates/ghost/1.0.0/icon.svg", "", "attachment"},
		{"/templates/ghost/1.0.0/icon.svg", "bytes=0-3", "attachment"},
		{"/templates/ghost/1.0.0/template.yaml", "", ""},
		{"/grafts/forum/1.0.0/forum.graft", "", ""},
		{"/templates/index.json", "", ""},
		{"/templates/missing/1.0.0/icon.svg", "", ""},
		{"/healthz", "", ""},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, c.path, nil)
		if c.range_ != "" {
			req.Header.Set("Range", c.range_)
		}
		s.ServeHTTP(rec, req)
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: nosniff = %q", c.path, got)
		}
		if got := rec.Header().Get("Content-Security-Policy"); got != assetCSP {
			t.Errorf("%s: csp = %q", c.path, got)
		}
		if got := rec.Header().Get("Content-Disposition"); got != c.disposition {
			t.Errorf("%s (range %q): disposition = %q, want %q", c.path, c.range_, got, c.disposition)
		}
	}
}

func TestDispositionFor(t *testing.T) {
	attach := map[string]string{
		"a/icon.svg":  "",
		"a/icon.png":  "image/svg+xml; charset=utf-8",
		"a/page.html": "text/html",
		"a/x":         "application/xhtml+xml",
	}
	for key, ctype := range attach {
		if dispositionFor(key, ctype) != "attachment" {
			t.Errorf("%s %s should be an attachment", key, ctype)
		}
	}
	inline := map[string]string{
		"a/icon.png":    "image/png",
		"a/index.json":  "application/json; charset=utf-8",
		"a/x.graft":     "application/gzip",
		"a/template.md": "text/markdown",
	}
	for key, ctype := range inline {
		if dispositionFor(key, ctype) != "" {
			t.Errorf("%s %s should stay inline", key, ctype)
		}
	}
}
