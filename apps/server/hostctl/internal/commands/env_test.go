package commands

import (
	"fmt"
	"strings"
	"testing"
)

func collect() (func(string, ...any), *strings.Builder) {
	var b strings.Builder
	return func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }, &b
}

const secretsEnv = "server:\n  env:\n    - {name: JWT_SECRET, value: jwt}\n    - {name: SECRETS_ENCRYPTION_KEY, value: enc}\n"

func TestEnvSetUpsertsWithoutTouchingTheSecrets(t *testing.T) {
	values := load(t, secretsEnv)
	out, _ := collect()
	changed, err := runEnv(values, "server.env", []string{"set", "SMTP_HOST", "smtp.example.com"}, out)
	if err != nil || !changed {
		t.Fatalf("set should change the file, got changed=%v err=%v", changed, err)
	}
	if _, err := runEnv(values, "server.env", []string{"set", "SMTP_HOST", "mail.example.com"}, out); err != nil {
		t.Fatal(err)
	}
	if got := values.EnvValue("server.env", "SMTP_HOST"); got != "mail.example.com" {
		t.Fatalf("expected the second value to win, got %q", got)
	}
	if got := len(values.List("server.env")); got != 3 {
		t.Fatalf("expected 3 entries, got %d", got)
	}
	if got := values.EnvValue("server.env", "SECRETS_ENCRYPTION_KEY"); got != "enc" {
		t.Fatalf("the encryption key must survive, got %q", got)
	}
}

func TestEnvGetPrintsTheValueAndFailsWhenMissing(t *testing.T) {
	values := load(t, secretsEnv)
	out, b := collect()
	if _, err := runEnv(values, "server.env", []string{"get", "JWT_SECRET"}, out); err != nil {
		t.Fatal(err)
	}
	if b.String() != "jwt\n" {
		t.Fatalf("expected jwt, got %q", b.String())
	}
	if _, err := runEnv(values, "server.env", []string{"get", "NOPE"}, out); err == nil {
		t.Fatal("getting an unset name should fail")
	}
}

func TestEnvUnsetLeavesTheRest(t *testing.T) {
	values := load(t, secretsEnv)
	out, _ := collect()
	changed, err := runEnv(values, "server.env", []string{"unset", "JWT_SECRET"}, out)
	if err != nil || !changed {
		t.Fatalf("unset should change the file, got changed=%v err=%v", changed, err)
	}
	changed, err = runEnv(values, "server.env", []string{"unset", "JWT_SECRET"}, out)
	if err != nil || changed {
		t.Fatalf("a second unset is a no-op, got changed=%v err=%v", changed, err)
	}
	if names := values.EnvNames("server.env"); len(names) != 1 || names[0] != "SECRETS_ENCRYPTION_KEY" {
		t.Fatalf("expected only the encryption key left, got %v", names)
	}
}

func TestEnvListPrintsNamesNotValues(t *testing.T) {
	values := load(t, secretsEnv)
	out, b := collect()
	if _, err := runEnv(values, "server.env", []string{"list"}, out); err != nil {
		t.Fatal(err)
	}
	if b.String() != "JWT_SECRET\nSECRETS_ENCRYPTION_KEY\n" || strings.Contains(b.String(), "enc") {
		t.Fatalf("unexpected listing %q", b.String())
	}
}

func TestEnvRejectsBadNames(t *testing.T) {
	values := load(t, secretsEnv)
	out, _ := collect()
	for _, name := range []string{"", "1ABC", "A-B", "A.B"} {
		if _, err := runEnv(values, "server.env", []string{"set", name, "x"}, out); err == nil {
			t.Fatalf("%q should be refused", name)
		}
	}
}

func TestEnvForPicksTheList(t *testing.T) {
	rest, path, err := envPathFor([]string{"set", "--for", "mcp", "A", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if path != "mcp.env" || strings.Join(rest, " ") != "set A b" {
		t.Fatalf("got path %q rest %v", path, rest)
	}
	if _, path, _ := envPathFor([]string{"get", "A"}); path != "server.env" {
		t.Fatalf("server.env is the default, got %q", path)
	}
	if _, _, err := envPathFor([]string{"get", "A", "--for", "worker"}); err == nil {
		t.Fatal("an unknown target should be refused")
	}
}

func TestEnvSetRefusesAnEnvThatIsNotAList(t *testing.T) {
	values := load(t, "server:\n  env: oops\n")
	out, _ := collect()
	if _, err := runEnv(values, "server.env", []string{"set", "A", "b"}, out); err == nil {
		t.Fatal("a scalar server.env should be reported, not silently replaced")
	}
}
