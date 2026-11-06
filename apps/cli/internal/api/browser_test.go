package api

import "testing"

func TestBrowsableURLOnlyAllowsPlainHTTP(t *testing.T) {
	for _, ok := range []string{"https://orchard.example/auth?x=1", "http://localhost:3000/cb"} {
		if _, err := browsableURL(ok); err != nil {
			t.Errorf("%q should open: %v", ok, err)
		}
	}
	for _, bad := range []string{
		"file:///etc/passwd",
		"ms-msdt:/id PCWDiagnostic",
		"javascript:alert(1)",
		"-oProxyCommand=evil",
		"https://orchard.example/\x1b]0;x\x07",
		"https://orchard.example/ with space",
		"https:///nohost",
		"",
	} {
		if _, err := browsableURL(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
}
