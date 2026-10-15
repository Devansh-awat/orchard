//go:build !windows

package agentd

import "testing"

func TestLoginCallbackOnlyAcceptsLocalhost(t *testing.T) {
	for _, ok := range []string{
		"http://localhost:1455/auth/callback?code=a&state=b",
		"http://127.0.0.1:54545/callback?code=a",
		"http://[::1]:1455/x",
	} {
		if _, err := localCallback(ok); err != nil {
			t.Fatalf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"https://localhost:1455/auth/callback",
		"http://localhost/auth/callback",
		"http://evil.test:1455/auth/callback",
		"http://169.254.169.254:80/latest",
		"file:///etc/passwd",
		"not a url",
	} {
		if _, err := localCallback(bad); err == nil {
			t.Fatalf("%s was accepted", bad)
		}
	}
}
