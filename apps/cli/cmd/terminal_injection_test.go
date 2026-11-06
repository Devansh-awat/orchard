package cmd

import "testing"

func TestEnvKeyPatternRefusesInjectedNames(t *testing.T) {
	for _, ok := range []string{"DATABASE_URL", "_X", "a.b-c", "PORT1"} {
		if !envKeyRe.MatchString(ok) {
			t.Errorf("%q should be a valid env name", ok)
		}
	}
	for _, bad := range []string{"", "1ABC", "A=1\nEVIL", "A B", "A\x1b[2J", "A;rm -rf", "A$(x)", "A\r", "-X"} {
		if envKeyRe.MatchString(bad) {
			t.Errorf("%q must be refused", bad)
		}
	}
}

func TestSandboxHostNamePatternRefusesSSHConfigInjection(t *testing.T) {
	for _, ok := range []string{"dev", "my-box.1", "A_b"} {
		if !sandboxHostNamePattern.MatchString(ok) {
			t.Errorf("%q should be a valid host alias", ok)
		}
	}
	for _, bad := range []string{"", "a\n  ProxyCommand evil", "a b", "-oProxyCommand=x", "a\x1b[2J", "a/b", "a%h"} {
		if sandboxHostNamePattern.MatchString(bad) {
			t.Errorf("%q must be refused", bad)
		}
	}
}
