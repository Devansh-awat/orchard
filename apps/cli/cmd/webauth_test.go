package cmd

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/config"
)

// drives webLogin by capturing the printed callback URL and simulating the
// browser hitting the loopback endpoint, exactly as the /cli/auth page would.
func TestWebLoginLoopback(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/auth/me" {
			if r.Header.Get("Authorization") != "Bearer orch_good" {
				w.WriteHeader(401)
				return
			}
			io.WriteString(w, `{"email":"raven@hackclub.com"}`)
			return
		}
		w.WriteHeader(404)
	}))
	defer api.Close()

	t.Setenv("HOME", t.TempDir()) // isolate config.Save()
	cfg := &config.Config{APIURL: api.URL}

	// Capture stderr to recover the chosen loopback port + state.
	origStderr := os.Stderr
	pr, pw, _ := os.Pipe()
	os.Stderr = pw
	defer func() { os.Stderr = origStderr }()

	done := make(chan error, 1)
	go func() { done <- webLogin(cfg, api.URL, false) }()

	port, state := waitForCallback(t, pr)
	cbURL := "http://127.0.0.1:" + port + "/callback?" + url.Values{
		"state": {state},
		"token": {"orch_good"},
	}.Encode()

	// give the loopback server a moment to be ready, then hit it
	var resp *http.Response
	var err error
	for i := 0; i < 50; i++ {
		resp, err = http.Get(cbURL)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("callback request failed: %v", err)
	}
	resp.Body.Close()

	select {
	case e := <-done:
		if e != nil {
			t.Fatalf("webLogin returned error: %v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webLogin did not complete")
	}

	if cfg.Token != "orch_good" {
		t.Fatalf("token not stored, got %q", cfg.Token)
	}
}

// a callback with the wrong state is answered 400 and ignored: the login keeps
// waiting for the real callback and must not store a token.
func TestWebLoginRejectsBadState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := &config.Config{APIURL: "http://127.0.0.1:1"} // never reached

	origStderr := os.Stderr
	pr, pw, _ := os.Pipe()
	os.Stderr = pw
	defer func() { os.Stderr = origStderr }()

	done := make(chan error, 1)
	go func() { done <- webLogin(cfg, "http://127.0.0.1:1", false) }()

	port, state := waitForCallback(t, pr)
	cbURL := "http://127.0.0.1:" + port + "/callback?state=WRONG&token=orch_evil"
	var resp *http.Response
	var err error
	for i := 0; i < 50; i++ {
		resp, err = http.Get(cbURL)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("callback request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad-state callback status = %d, want 400", resp.StatusCode)
	}

	select {
	case e := <-done:
		t.Fatalf("webLogin returned after bad-state callback: %v", e)
	case <-time.After(200 * time.Millisecond):
	}

	denyURL := "http://127.0.0.1:" + port + "/callback?" + url.Values{
		"state": {state},
		"error": {"access_denied"},
	}.Encode()
	if r, derr := http.Get(denyURL); derr == nil {
		r.Body.Close()
	}
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("expected error on denied callback, got nil")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webLogin did not return after denied callback")
	}
	if cfg.Token != "" {
		t.Fatalf("token should not be stored, got %q", cfg.Token)
	}
}

// the browser page POSTs the token as a form body so it never lands in history.
func TestWebLoginAcceptsPostForm(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/apiv1/auth/me" && r.Header.Get("Authorization") == "Bearer orch_post" {
			io.WriteString(w, `{"email":"raven@hackclub.com"}`)
			return
		}
		w.WriteHeader(401)
	}))
	defer api.Close()

	t.Setenv("HOME", t.TempDir())
	cfg := &config.Config{APIURL: api.URL}

	origStderr := os.Stderr
	pr, pw, _ := os.Pipe()
	os.Stderr = pw
	defer func() { os.Stderr = origStderr }()

	done := make(chan error, 1)
	go func() { done <- webLogin(cfg, api.URL, false) }()

	port, state := waitForCallback(t, pr)
	cbURL := "http://127.0.0.1:" + port + "/callback"
	form := url.Values{"state": {state}, "token": {"orch_post"}}
	var err error
	for i := 0; i < 50; i++ {
		var resp *http.Response
		resp, err = http.PostForm(cbURL, form)
		if err == nil {
			resp.Body.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("callback request failed: %v", err)
	}

	select {
	case e := <-done:
		if e != nil {
			t.Fatalf("webLogin returned error: %v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webLogin did not complete")
	}
	if cfg.Token != "orch_post" {
		t.Fatalf("token not stored, got %q", cfg.Token)
	}
}

func waitForCallback(t *testing.T, r io.Reader) (port, state string) {
	t.Helper()
	re := regexp.MustCompile(`port=(\d+)&state=([0-9a-f]+)`)
	sc := bufio.NewScanner(r)
	deadline := time.Now().Add(3 * time.Second)
	for sc.Scan() && time.Now().Before(deadline) {
		line := sc.Text()
		if !strings.Contains(line, "cli/auth") {
			continue
		}
		if m := re.FindStringSubmatch(line); m != nil {
			return m[1], m[2]
		}
	}
	t.Fatal("never saw callback URL on stderr")
	return "", ""
}
