//go:build linux

package agentd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func waitLogin(t *testing.T, h *harness, id string, until func(loginStatus) bool) loginStatus {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st, err := h.d.logins.Status(id)
		if err != nil {
			t.Fatal(err)
		}
		if until(st) {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("login never reached the expected state: %+v", st)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestLoginRunsInATerminalAndTakesInput(t *testing.T) {
	h := newHarness(t)
	script := `[ -t 0 ] && echo tty-yes; printf 'Open https://example.test/device\nCode: ABCD-1234\n'; read code; echo "got:$code"; echo "token sk-ant-oat01-abc"`
	st, err := h.d.logins.Start(context.Background(), loginStartParams{Agent: "fake", Command: []string{"sh", "-c", script}})
	if err != nil {
		t.Fatal(err)
	}
	waitLogin(t, h, st.LoginID, func(s loginStatus) bool { return strings.Contains(s.Output, "Code: ABCD-1234") })
	if err := h.d.logins.Input(st.LoginID, "pasted-code"); err != nil {
		t.Fatal(err)
	}
	done := waitLogin(t, h, st.LoginID, func(s loginStatus) bool { return s.State == "exited" })
	for _, want := range []string{"tty-yes", "got:pasted-code", "sk-ant-oat01-abc"} {
		if !strings.Contains(done.Output, want) {
			t.Fatalf("output %q is missing %q", done.Output, want)
		}
	}
	if done.ExitCode == nil || *done.ExitCode != 0 {
		t.Fatalf("exit code %v", done.ExitCode)
	}
}

func TestLoginAnswersCursorQueries(t *testing.T) {
	h := newHarness(t)
	script := `stty raw -echo; printf '\033[6n'; reply=$(dd bs=6 count=1 2>/dev/null | od -c | head -1); stty sane; echo "reply:$reply"`
	st, err := h.d.logins.Start(context.Background(), loginStartParams{Agent: "fake", Command: []string{"sh", "-c", script}})
	if err != nil {
		t.Fatal(err)
	}
	done := waitLogin(t, h, st.LoginID, func(s loginStatus) bool { return s.State == "exited" })
	if !strings.Contains(done.Output, "R") {
		t.Fatalf("cursor query went unanswered: %q", done.Output)
	}
}

func TestLoginCallbackReachesTheLocalListener(t *testing.T) {
	h := newHarness(t)
	hit := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit <- r.URL.RawQuery
	}))
	defer srv.Close()
	st, err := h.d.logins.Start(context.Background(), loginStartParams{Agent: "fake", Command: []string{"sh", "-c", "sleep 5"}})
	if err != nil {
		t.Fatal(err)
	}
	defer h.d.logins.Cancel(st.LoginID)
	cb := strings.Replace(srv.URL, "127.0.0.1", "localhost", 1) + "/auth/callback?code=abc&state=xyz"
	res, err := h.d.logins.Callback(context.Background(), st.LoginID, cb)
	if err != nil {
		t.Fatal(err)
	}
	if res["status"] != 200 {
		t.Fatalf("status %d", res["status"])
	}
	if got := <-hit; got != "code=abc&state=xyz" {
		t.Fatalf("query %q", got)
	}
}

func TestStartingALoginStopsThePreviousOne(t *testing.T) {
	h := newHarness(t)
	first, err := h.d.logins.Start(context.Background(), loginStartParams{Agent: "fake", Command: []string{"sh", "-c", "sleep 30"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.d.logins.Start(context.Background(), loginStartParams{Agent: "fake", Command: []string{"sh", "-c", "sleep 30"}}); err != nil {
		t.Fatal(err)
	}
	waitLogin(t, h, first.LoginID, func(s loginStatus) bool { return s.State == "exited" })
}
