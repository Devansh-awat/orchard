package commands

import "testing"

// Everything here is what someone pastes when they have been told "the
// dashboard is at X": a URL, a name with the port on it, a trailing slash.
func TestCleanHostnameTakesWhatPeoplePaste(t *testing.T) {
	for raw, want := range map[string]string{
		"mango":                   "mango",
		"  mango  ":               "mango",
		"http://mango":            "mango",
		"https://mango:8081/":     "mango",
		"mango:8081":              "mango",
		"mango.local.":            "mango.local",
		"192.168.4.27":            "192.168.4.27",
		"http://192.168.4.27:443": "192.168.4.27",
		"mango/dashboard/":        "mango",
	} {
		got, err := cleanHostname(raw)
		if err != nil {
			t.Fatalf("cleanHostname(%q): %v", raw, err)
		}
		if got != want {
			t.Errorf("cleanHostname(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestCleanHostnameRejectsWhatTraefikCannotMatch(t *testing.T) {
	for _, raw := range []string{"", "   ", "http://", "man go", "/dashboard", "mango_box"} {
		if got, err := cleanHostname(raw); err == nil {
			t.Errorf("cleanHostname(%q) = %q, want an error", raw, got)
		}
	}
}

func TestClaimBaseFillsInTheSchemeAndPort(t *testing.T) {
	lan := load(t, `
ingress:
  host: 192.168.4.27
  tls:
    enabled: false
server:
  env:
    - { name: PUBLIC_HTTP_PORT, value: "8081" }
    - { name: PUBLIC_HTTPS_PORT, value: "8443" }
`)
	for raw, want := range map[string]string{
		"mango":               "http://mango:8081",
		"mango:9999":          "http://mango:9999",
		"http://mango":        "http://mango",
		"https://mango:8443/": "https://mango:8443",
		"192.168.4.27":        "http://192.168.4.27:8081",
	} {
		got, err := claimBase(lan, raw)
		if err != nil {
			t.Fatalf("claimBase(%q): %v", raw, err)
		}
		if got != want {
			t.Errorf("claimBase(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestClaimBaseLeavesStandardPortsOff(t *testing.T) {
	public := load(t, `
ingress:
  host: orchard.example.com
  tls:
    enabled: true
server:
  env:
    - { name: PUBLIC_HTTPS_PORT, value: "443" }
`)
	got, err := claimBase(public, "orchard.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://orchard.example.com" {
		t.Errorf("claimBase = %q, want https://orchard.example.com", got)
	}
}
