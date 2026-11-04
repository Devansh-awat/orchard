package commands

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const tapKey = "q1Wb0n1y8bWkS3xAq6v0n3vY1R4m8jYJb0nq8l2hX0E="

func versionsFor(id string) []marketVersion {
	compatible := map[string]string{"platform": ">=2.0.0 <3", "sdk": "^1.0.0"}
	return []marketVersion{
		{Version: "1.0.0", Digest: "sha256:" + id + "100", Engines: compatible},
		{Version: "1.1.0", Digest: "sha256:" + id + "110", Engines: compatible},
		{Version: "1.2.0", Digest: "sha256:" + id + "120", Engines: compatible, Revoked: true},
		{Version: "2.0.0", Digest: "sha256:" + id + "200", Engines: map[string]string{"platform": ">=3.0.0", "sdk": "^1.0.0"}},
	}
}

func serveJSON(t *testing.T, routes map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := routes[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fakeTap(t *testing.T) *httptest.Server {
	t.Helper()
	return serveJSON(t, map[string]any{
		"/tap.json": tapManifest{Name: "acme", Description: "Acme's grafts", PublicKey: tapKey},
		"/grafts/index.json": marketIndex{Grafts: []marketGraft{
			{ID: "notes", Name: "Notes", Description: "Take notes", Publisher: "acme", Tier: "tap", Latest: "2.0.0", Versions: versionsFor("tap")},
		}},
	})
}

func fakeMarket(t *testing.T) *httptest.Server {
	t.Helper()
	return serveJSON(t, map[string]any{
		"/grafts/index.json": marketIndex{Grafts: []marketGraft{
			{ID: "announcements", Name: "Announcements", Description: "Banners", Publisher: "orchard", Latest: "1.1.0", Versions: versionsFor("ann")},
			{ID: "notes", Name: "Notes", Description: "Take notes", Publisher: "acme", Tier: "community", Repo: "acme/orchard-notes", Latest: "1.1.0", Versions: versionsFor("market")},
		}},
	})
}

func valuesFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "values.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runGraftCmd(t *testing.T, path string, args ...string) (string, error) {
	t.Helper()
	out, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	ctx := &cli.Context{Env: cli.Env{Values: path, Namespace: "orchard", Kubeconfig: filepath.Join(t.TempDir(), "missing")}, Stdout: out, Stderr: out}
	runErr := Graft().Run(ctx, args)
	printed, _ := os.ReadFile(out.Name())
	return string(printed), runErr
}

func TestGraftTapAddListRemove(t *testing.T) {
	t.Setenv("ORCHARD_GRAFTS_ALLOW_HTTP", "1")
	tap := fakeTap(t)
	path := valuesFile(t, "signupMode: open\ngraftSettings:\n  trust: signed\n")

	out, err := runGraftCmd(t, path, "tap", "add", "acme", tap.URL+"/", "--yes")
	if err != nil {
		t.Fatal(err)
	}
	keyID, _ := graftKeyID(tapKey)
	for _, want := range []string{tap.URL, keyID, "Orchard hasn't checked anything in this tap. Install it only if you trust acme.", "orchardctl graft trust taps"} {
		if !strings.Contains(out, want) {
			t.Errorf("tap add output is missing %q:\n%s", want, out)
		}
	}
	values, _ := cli.LoadValues(path)
	taps := readTaps(values)
	if len(taps) != 1 || taps[0] != (graftTap{Name: "acme", URL: tap.URL, Key: tapKey}) {
		t.Fatalf("taps not written: %+v", taps)
	}
	if values.Get("signupMode") != "open" || values.Get("graftSettings.trust") != "signed" {
		t.Fatal("tap add clobbered other values")
	}

	if _, err := runGraftCmd(t, path, "tap", "add", "acme", tap.URL, "--yes"); err == nil {
		t.Fatal("a second tap with the same name should be refused")
	}
	if _, err := runGraftCmd(t, path, "tap", "add", "Acme!", tap.URL, "--yes"); err == nil {
		t.Fatal("an invalid tap name should be refused")
	}
	t.Setenv("ORCHARD_GRAFTS_ALLOW_HTTP", "")
	if _, err := runGraftCmd(t, path, "tap", "add", "plain", tap.URL, "--yes"); err == nil {
		t.Fatal("plain http taps need ORCHARD_GRAFTS_ALLOW_HTTP")
	}

	out, err = runGraftCmd(t, path, "tap", "list")
	if err != nil || !strings.Contains(out, "acme") || !strings.Contains(out, keyID) {
		t.Fatalf("tap list: %v\n%s", err, out)
	}

	values.SetList(graftsPath, []any{map[string]any{"id": "notes", "version": "1.1.0", "digest": "sha256:tap110", "tap": "acme"}})
	values.Save()
	if _, err := runGraftCmd(t, path, "tap", "remove", "acme"); err == nil || !strings.Contains(err.Error(), "notes") {
		t.Fatalf("removing a tap that is in use should name the graft, got %v", err)
	}
	values.SetList(graftsPath, []any{})
	values.Save()
	if _, err := runGraftCmd(t, path, "tap", "remove", "acme"); err != nil {
		t.Fatal(err)
	}
	values, _ = cli.LoadValues(path)
	if len(readTaps(values)) != 0 {
		t.Fatal("tap was not removed")
	}
	if _, err := runGraftCmd(t, path, "tap", "remove", "acme"); err == nil {
		t.Fatal("removing an unknown tap should fail")
	}
}

func TestResolveTapSpecPicksNewestCompatible(t *testing.T) {
	tap := fakeTap(t)
	path := valuesFile(t, "graftSettings:\n  taps:\n    - name: acme\n      url: "+tap.URL+"\n      key: "+tapKey+"\n")
	values, _ := cli.LoadValues(path)
	platform := func() (string, error) { return "2.70.0", nil }

	spec, err := resolveTapSpec(values, "acme", "notes", "", platform)
	if err != nil {
		t.Fatal(err)
	}
	if spec != (graftSpec{ID: "notes", Version: "1.1.0", Digest: "sha256:tap110", Tap: "acme"}) {
		t.Fatalf("expected the newest compatible unrevoked version, got %+v", spec)
	}
	spec, err = resolveTapSpec(values, "acme", "notes", "1.0.0", platform)
	if err != nil || spec.Version != "1.0.0" || spec.Digest != "sha256:tap100" {
		t.Fatalf("pinned version: %+v %v", spec, err)
	}
	if _, err := resolveTapSpec(values, "acme", "notes", "1.2.0", platform); err == nil {
		t.Fatal("a revoked version must not install")
	}
	if _, err := resolveTapSpec(values, "other", "notes", "", platform); err == nil {
		t.Fatal("an unknown tap must not resolve")
	}
	if _, err := resolveTapSpec(values, "acme", "tasks", "", platform); err == nil {
		t.Fatal("a graft the tap does not have must not resolve")
	}

	writeGraftSpecs(values, []graftSpec{spec})
	values.Save()
	reloaded, _ := cli.LoadValues(path)
	if got := readGraftSpecs(reloaded); len(got) != 1 || got[0].Tap != "acme" || got[0].Source != "" {
		t.Fatalf("tap specs must round trip as { id, version, digest, tap }: %+v", got)
	}
	env := strings.Join(graftTrustEnv(reloaded), "\n")
	if !strings.Contains(env, `ORCHARD_GRAFT_TAPS=[{"name":"acme","url":"`+tap.URL+`","key":"`+tapKey+`"}]`) {
		t.Fatalf("server env is missing the taps: %s", env)
	}
}

func TestGraftAddRefusesAnIDFromAnotherSource(t *testing.T) {
	tap := fakeTap(t)
	market := fakeMarket(t)
	settings := "graftSettings:\n  marketplaceUrl: " + market.URL + "\n  taps:\n    - name: acme\n      url: " + tap.URL + "\n      key: " + tapKey + "\n"

	path := valuesFile(t, settings+"grafts:\n  - id: notes\n    version: 1.0.0\n    digest: sha256:market100\n")
	if _, err := runGraftCmd(t, path, "add", "acme/notes@1.1.0", "--yes"); err == nil || !strings.Contains(err.Error(), "already installed from the Extension Marketplace") {
		t.Fatalf("expected a refusal, got %v", err)
	}

	path = valuesFile(t, settings+"grafts:\n  - id: notes\n    version: 1.0.0\n    digest: sha256:tap100\n    tap: acme\n")
	if _, err := runGraftCmd(t, path, "add", "notes@1.1.0", "--yes"); err == nil || !strings.Contains(err.Error(), "already installed from the acme tap") {
		t.Fatalf("expected a refusal, got %v", err)
	}
	if _, err := runGraftCmd(t, path, "add", "ghost/notes@1.1.0", "--yes"); err == nil || !strings.Contains(err.Error(), "no tap called ghost") {
		t.Fatalf("an unknown tap should be named, got %v", err)
	}
}

func TestGraftSearchAndInfoShowTiers(t *testing.T) {
	tap := fakeTap(t)
	market := fakeMarket(t)
	path := valuesFile(t, "graftSettings:\n  marketplaceUrl: "+market.URL+"\n  taps:\n    - name: acme\n      url: "+tap.URL+"\n      key: "+tapKey+"\n")

	out, err := runGraftCmd(t, path, "search")
	if err != nil {
		t.Fatal(err)
	}
	lines := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if fields := strings.Fields(line); len(fields) > 0 {
			lines[fields[0]] = line
		}
	}
	if !strings.Contains(lines["announcements"], "official") {
		t.Errorf("official graft not labelled: %q", lines["announcements"])
	}
	if !strings.Contains(lines["notes"], "community by acme") {
		t.Errorf("community graft not labelled: %q", lines["notes"])
	}
	if !strings.Contains(lines["acme/notes"], "tap:acme") {
		t.Errorf("tap graft not labelled: %q", lines["acme/notes"])
	}

	out, err = runGraftCmd(t, path, "info", "notes")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"tier:      community by acme", "repo:      github.com/acme/orchard-notes", "Published by acme (github.com/acme/orchard-notes), not by Orchard."} {
		if !strings.Contains(out, want) {
			t.Errorf("info is missing %q:\n%s", want, out)
		}
	}
	out, err = runGraftCmd(t, path, "info", "acme/notes")
	if err != nil || !strings.Contains(out, "From the acme tap at "+tap.URL+".") || !strings.Contains(out, "revoked") {
		t.Fatalf("tap info: %v\n%s", err, out)
	}
}

func TestSignatureCopyByTier(t *testing.T) {
	tap := "https://acme.dev/orchard"
	values, _ := cli.LoadValues(valuesFile(t, "graftSettings:\n  taps:\n    - name: acme\n      url: "+tap+"\n      key: "+tapKey+"\n"))
	str := func(s string) *string { return &s }
	cases := []struct {
		spec graftSpec
		sig  *graftSignature
		want string
	}{
		{graftSpec{ID: "a"}, &graftSignature{Tier: str("official"), SignedBy: str("official")}, "Signed by Orchard."},
		{graftSpec{ID: "a"}, &graftSignature{Tier: str("community"), SignedBy: str("publisher"), Publisher: "acme", Repo: "acme/orchard-notes"}, "Published by acme (github.com/acme/orchard-notes), not by Orchard. Orchard checked it when it was listed, but doesn't review its updates."},
		{graftSpec{ID: "a", Tap: "acme"}, &graftSignature{Tier: str("tap"), SignedBy: str("publisher"), Tap: "acme"}, "From the acme tap at https://acme.dev/orchard. Orchard hasn't checked anything in this tap. Install it only if you trust acme."},
		{graftSpec{ID: "a"}, &graftSignature{Tier: str("publisher"), SignedBy: str("publisher"), KeyID: str("0123456789abcdef")}, "Signed by publisher key 0123456789abcdef."},
		{graftSpec{ID: "a"}, &graftSignature{SignedBy: str("publisher"), KeyID: str("0123456789abcdef")}, "Signed by publisher key 0123456789abcdef."},
		{graftSpec{ID: "a"}, &graftSignature{}, graftUnsignedWarning},
		{graftSpec{ID: "a"}, nil, graftUnsignedWarning},
	}
	for i, c := range cases {
		if got := signatureCopy(values, c.spec, c.sig); got != c.want {
			t.Errorf("case %d: got %q, want %q", i, got, c.want)
		}
		if strings.Contains(signatureCopy(values, c.spec, c.sig), "\u2014") {
			t.Errorf("case %d uses an em dash", i)
		}
	}
}

func TestGraftTrustAcceptsNewLevels(t *testing.T) {
	path := valuesFile(t, "graftSettings:\n  trust: signed\n")
	out, err := runGraftCmd(t, path, "trust")
	if err != nil || !strings.Contains(out, "trust policy: listed") {
		t.Fatalf("signed should be shown as listed: %v\n%s", err, out)
	}
	for _, c := range []struct{ arg, want string }{{"taps", "taps"}, {"official", "official"}, {"any", "any"}, {"signed", "listed"}, {"listed", "listed"}} {
		if _, err := runGraftCmd(t, path, "trust", c.arg); err != nil {
			t.Fatal(err)
		}
		values, _ := cli.LoadValues(path)
		if got := values.Get("graftSettings.trust"); got != c.want {
			t.Fatalf("trust %s wrote %v, want %s", c.arg, got, c.want)
		}
	}
	if _, err := runGraftCmd(t, path, "trust", "everything"); err == nil {
		t.Fatal("an unknown level should be refused")
	}
	empty := valuesFile(t, "signupMode: open\n")
	out, _ = runGraftCmd(t, empty, "trust")
	if !strings.Contains(out, "trust policy: listed") {
		t.Fatalf("the default should read as listed:\n%s", out)
	}
}
