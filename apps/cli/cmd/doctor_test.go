package cmd

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/exitcode"
)

func doctorTestRoot(t *testing.T, srvURL string) func(args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ORCHARD_API_URL", srvURL)
	t.Setenv("ORCHARD_API_TOKEN", "tok")
	t.Setenv("ORCHARD_ORG", "")
	t.Setenv("ORCHARD_PROJECT", "")
	t.Setenv("ORCHARD_ENV", "")
	return func(args ...string) (string, error) {
		root := rootCmd()
		root.SetArgs(args)
		root.SetOut(io.Discard)
		root.SetErr(io.Discard)
		var err error
		out := captureStdout(t, func() { err = root.ExecuteContext(context.Background()) })
		return out, err
	}
}

func TestDoctorExitsNonZeroOnFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/admin/doctor" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
			return
		}
		io.WriteString(w, `{"generatedAt":"2026-01-01T00:00:00Z","summary":{"pass":1,"warn":0,"fail":1,"unknown":0},"checks":[
			{"id":"redis-auth","title":"Redis","status":"pass","evidence":"ok","fix":"","docs":"https://docs.example/operate/doctor/#redis-auth"},
			{"id":"default-deny-coverage","title":"Deny","status":"fail","evidence":"3 of 9 namespaces have no policy","fix":"Restart the server","docs":"https://docs.example/operate/doctor/#default-deny-coverage"}
		],"selftest":null}`)
	}))
	defer srv.Close()
	run := doctorTestRoot(t, srv.URL)

	out, err := run("doctor", "-o", "table")
	if err == nil || exitcode.FromError(err) != exitcode.ChecksFailed {
		t.Fatalf("err = %v, want exit code %d", err, exitcode.ChecksFailed)
	}
	for _, want := range []string{"default-deny-coverage", "3 of 9 namespaces", "Restart the server", "1 pass, 0 warn, 1 fail, 0 unknown"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}

	jsonOut, err := run("doctor", "-o", "json")
	if exitcode.FromError(err) != exitcode.ChecksFailed {
		t.Fatalf("json mode err = %v, want checks failed", err)
	}
	if !strings.Contains(jsonOut, `"default-deny-coverage"`) {
		t.Errorf("json output missing check:\n%s", jsonOut)
	}
}

func TestDoctorPassesWithWarnAndUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"generatedAt":"x","summary":{},"checks":[
			{"id":"a","title":"A","status":"warn","evidence":"meh","fix":"do x","docs":""},
			{"id":"b","title":"B","status":"unknown","evidence":"cannot tell","fix":"","docs":""}
		],"selftest":null}`)
	}))
	defer srv.Close()
	run := doctorTestRoot(t, srv.URL)
	if _, err := run("doctor", "-o", "table"); err != nil {
		t.Fatalf("warn and unknown must not fail the command: %v", err)
	}
}

func TestDoctorStripsTerminalEscapesFromServerStrings(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"checks":[{"id":"x","title":"t","status":"warn","evidence":"bad \u001b]0;pwned\u0007 \u001b[31mred","fix":"fix \u001b[2J now","docs":"https://d\u001b[1m"}],"selftest":null}`)
	}))
	defer srv.Close()
	run := doctorTestRoot(t, srv.URL)
	out, err := run("doctor", "-o", "table")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "pwned\x07") || strings.Contains(out, "\x1b]") || strings.Contains(out, "\x1b[2J") || strings.Contains(out, "\x1b[31m") {
		t.Errorf("escape sequences reached the terminal: %q", out)
	}
}

func TestDoctorSelfTestPollsUntilDone(t *testing.T) {
	var polls int32
	var posted int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/apiv1/admin/doctor":
			io.WriteString(w, `{"checks":[],"selftest":null}`)
		case r.URL.Path == "/apiv1/admin/doctor/selftest" && r.Method == http.MethodPost:
			atomic.AddInt32(&posted, 1)
			io.WriteString(w, `{"id":"st-1","status":"running","checks":[]}`)
		case r.URL.Path == "/apiv1/admin/doctor/selftest/st-1":
			if atomic.AddInt32(&polls, 1) < 2 {
				io.WriteString(w, `{"id":"st-1","status":"running","checks":[]}`)
				return
			}
			io.WriteString(w, `{"id":"st-1","status":"done","checks":[{"id":"selftest-nodes","title":"n","status":"fail","evidence":"reached 10.0.0.1:10250","fix":"firewall","docs":""}],"leftovers":[],"notes":["n1"]}`)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	old := doctorPollInterval
	doctorPollInterval = time.Millisecond
	defer func() { doctorPollInterval = old }()
	run := doctorTestRoot(t, srv.URL)

	out, err := run("doctor", "--selftest", "--yes", "-o", "table")
	if exitcode.FromError(err) != exitcode.ChecksFailed {
		t.Fatalf("err = %v, want checks failed from the self-test", err)
	}
	if posted != 1 || polls < 2 {
		t.Errorf("posted=%d polls=%d", posted, polls)
	}
	if !strings.Contains(out, "selftest-nodes") || !strings.Contains(out, "reached 10.0.0.1:10250") {
		t.Errorf("self-test result missing from output:\n%s", out)
	}
}

func TestDoctorSelfTestNeedsConfirmation(t *testing.T) {
	var posted int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			atomic.AddInt32(&posted, 1)
		}
		io.WriteString(w, `{"checks":[],"selftest":null}`)
	}))
	defer srv.Close()
	run := doctorTestRoot(t, srv.URL)
	_, err := run("doctor", "--selftest", "-o", "json")
	if err == nil || exitcode.FromError(err) != exitcode.Usage {
		t.Fatalf("err = %v, want a refused confirmation (usage exit)", err)
	}
	if posted != 0 {
		t.Errorf("self-test started without confirmation")
	}
}

func TestRunDoctorSelfTestTimesOut(t *testing.T) {
	send := func(path string, post bool, out any) error {
		run := out.(*doctorSelfTest)
		run.ID = "st-9"
		run.Status = "running"
		return nil
	}
	_, err := runDoctorSelfTest(context.Background(), send, 20*time.Millisecond, 5*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "did not finish") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunDoctorSelfTestPropagatesErrors(t *testing.T) {
	boom := errors.New("409 conflict")
	send := func(path string, post bool, out any) error { return boom }
	if _, err := runDoctorSelfTest(context.Background(), send, time.Second, time.Millisecond); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestDoctorFailuresCountsSelfTestErrors(t *testing.T) {
	r := doctorReport{Selftest: &doctorSelfTest{Status: "error"}}
	if doctorFailures(r) != 1 {
		t.Fatalf("a self-test that errored must count as a failure")
	}
}
