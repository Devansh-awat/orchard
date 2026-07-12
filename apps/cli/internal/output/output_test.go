package output

import (
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"testing"
)

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;]*m")

func stripANSI(s string) string {
	return ansiRE.ReplaceAllString(s, "")
}

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	os.Stdout = old
	w.Close()
	data, err := io.ReadAll(r)
	r.Close()
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func pipeStdin(t *testing.T) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = old
		w.Close()
		r.Close()
	})
}

func TestConfirm(t *testing.T) {
	t.Run("yes flag skips prompt", func(t *testing.T) {
		if err := Confirm("delete everything?", true); err != nil {
			t.Fatalf("got %v, want nil", err)
		}
	})
	t.Run("no tty refuses", func(t *testing.T) {
		pipeStdin(t)
		err := Confirm("delete everything?", false)
		if !errors.Is(err, ErrPromptRefused) {
			t.Fatalf("got %v, want ErrPromptRefused", err)
		}
	})
}

func TestNDJSON(t *testing.T) {
	out := captureStdout(t, func() {
		err := NDJSON(struct {
			Event string `json:"event"`
			Count int    `json:"count"`
		}{"deploy.ready", 3})
		if err != nil {
			t.Errorf("ndjson: %v", err)
		}
	})
	want := `{"event":"deploy.ready","count":3}` + "\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
	if strings.Count(out, "\n") != 1 {
		t.Fatalf("expected exactly one line, got %q", out)
	}
}

func TestKVAlignment(t *testing.T) {
	out := captureStdout(t, func() {
		KV([][2]string{
			{"name", "api"},
			{"status", "running"},
			{"id", "d1"},
		})
	})
	lines := strings.Split(strings.TrimRight(stripANSI(out), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %q", len(lines), out)
	}
	want := []string{
		"name    api",
		"status  running",
		"id      d1",
	}
	for i, w := range want {
		if lines[i] != w {
			t.Errorf("line %d: got %q, want %q", i, lines[i], w)
		}
	}
	for _, l := range lines {
		if idx := strings.LastIndex(l, "  "); idx+2 != 8 {
			t.Errorf("value in %q starts at column %d, want 8", l, idx+2)
		}
	}
}

func TestResolve(t *testing.T) {
	cases := []struct {
		name string
		flag string
		env  string
		want Format
	}{
		{"explicit json", "json", "", FormatJSON},
		{"explicit json beats env", "json", "1", FormatJSON},
		{"explicit table", "table", "", FormatTable},
		{"explicit table beats env", "table", "1", FormatTable},
		{"pretty alias", "pretty", "", FormatTable},
		{"case insensitive", "JSON", "", FormatJSON},
		{"env forces json", "", "1", FormatJSON},
		{"non-tty default json", "", "", FormatJSON},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORCHARD_JSON", tc.env)
			var got Format
			// stdout swapped for a pipe so IsTTY is deterministically false
			captureStdout(t, func() {
				got = Resolve(tc.flag)
			})
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
