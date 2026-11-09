package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func probeServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func TestProbeAcceptsOrchard(t *testing.T) {
	srv := probeServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/health" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected probe: %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		fmt.Fprint(w, `{"status":"ok","message":"Server is running","version":"0.1.0"}`)
	})
	got, err := ProbeInstance(context.Background(), srv.URL+"/")
	if err != nil || got != srv.URL {
		t.Fatalf("got %q, err %v", got, err)
	}
}

func TestProbeRejections(t *testing.T) {
	tests := []struct {
		name string
		h    http.HandlerFunc
		want string
	}{
		{"not found", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) }, "doesn't look like an Orchard instance"},
		{"html", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, "<html></html>") }, "doesn't look like an Orchard instance"},
		{"other json", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"status":"ok"}`) }, "doesn't look like an Orchard instance"},
		{"bad gateway", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(502) }, "may be down"},
		{"elsewhere", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://other.example/apiv1/health", http.StatusFound)
		}, "enter that address instead"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ProbeInstance(context.Background(), probeServer(t, tt.h).URL)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.want)
			}
		})
	}
}

func TestProbeConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	_, err = ProbeInstance(context.Background(), "http://"+addr)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err = %v", err)
	}
}

func TestProbeUntrustedCertificate(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)
	_, err := ProbeInstance(context.Background(), srv.URL)
	if err == nil || !strings.Contains(err.Error(), "TLS certificate") {
		t.Fatalf("err = %v", err)
	}
}

func TestProbePlainHTTPOnTLSURL(t *testing.T) {
	srv := probeServer(t, func(http.ResponseWriter, *http.Request) {})
	_, err := ProbeInstance(context.Background(), strings.Replace(srv.URL, "http://", "https://", 1))
	if err == nil || !strings.Contains(err.Error(), "http://") {
		t.Fatalf("err = %v", err)
	}
}

func TestDescribeUnresolvableHost(t *testing.T) {
	err := describeProbeError("https://nope.example", &url.Error{Op: "Get", URL: "x", Err: &net.DNSError{Err: "no such host", Name: "nope.example"}})
	if !strings.Contains(err.Error(), "doesn't resolve") {
		t.Fatalf("err = %v", err)
	}
}

func TestDescribeCancelStaysCancelled(t *testing.T) {
	if err := describeProbeError("https://a.example", context.Canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestHTTPSUpgrade(t *testing.T) {
	to := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	if got := httpsUpgrade("http://a.example", to("https://a.example:443/apiv1/health")); got != "https://a.example" {
		t.Fatalf("got %q", got)
	}
	for _, target := range []string{"https://b.example/", "http://a.example/x"} {
		if got := httpsUpgrade("http://a.example", to(target)); got != "" {
			t.Fatalf("%s: got %q", target, got)
		}
	}
}
