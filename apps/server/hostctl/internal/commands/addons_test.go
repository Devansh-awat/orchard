package commands

import "testing"

func TestAddonInstalledVersionReadsTheChart(t *testing.T) {
	listing := []byte(`[{"name":"traefik","chart":"traefik-42.3.0"},{"name":"other","chart":"other-1.0.0"}]`)
	version, found, err := addonInstalledVersion(listing, "traefik", "traefik")
	if err != nil || !found || version != "42.3.0" {
		t.Fatalf("got %q %v %v", version, found, err)
	}
	if _, found, err := addonInstalledVersion(listing, "cnpg", "cloudnative-pg"); err != nil || found {
		t.Fatalf("a missing release should be skipped: %v %v", found, err)
	}
	if _, _, err := addonInstalledVersion(listing, "other", "traefik"); err == nil {
		t.Fatal("a release from a different chart should not be upgraded")
	}
}

func TestChartVersionFromMetadata(t *testing.T) {
	version, err := chartVersionFromMetadata("apiVersion: v2\nappVersion: v3.7.17\nname: traefik\nversion: 42.3.0\n")
	if err != nil || version != "42.3.0" {
		t.Fatalf("got %q %v", version, err)
	}
	version, err = chartVersionFromMetadata("name: cert-manager\nversion: v1.21.3\n")
	if err != nil || version != "v1.21.3" {
		t.Fatalf("got %q %v", version, err)
	}
	if _, err := chartVersionFromMetadata("name: nothing\n"); err == nil {
		t.Fatal("metadata with no version should fail")
	}
}

func TestAddonActionStaysInTheMajorVersion(t *testing.T) {
	cases := []struct {
		installed, latest string
		upgrade, behind   bool
	}{
		{"42.3.0", "42.3.0", false, false},
		{"42.2.0", "42.3.0", true, false},
		{"0.28.0", "0.29.1", true, false},
		{"v1.20.0", "v1.21.3", true, false},
		{"41.0.0", "42.3.0", false, true},
		{"43.0.0", "42.3.0", false, false},
	}
	for _, tc := range cases {
		upgrade, behind, err := addonAction(tc.installed, tc.latest)
		if err != nil || upgrade != tc.upgrade || behind != tc.behind {
			t.Errorf("%s to %s: got %v %v %v", tc.installed, tc.latest, upgrade, behind, err)
		}
	}
	if _, _, err := addonAction("garbage", "1.0.0"); err == nil {
		t.Error("an unreadable version should fail")
	}
}

func TestEveryAddonNamesItsChart(t *testing.T) {
	for _, a := range addons {
		if a.release == "" || a.namespace == "" || a.chart == "" || a.repo == "" {
			t.Errorf("incomplete add-on: %+v", a)
		}
	}
}
