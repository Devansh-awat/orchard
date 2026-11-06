package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGraftCatalogIsSignedWithSequenceAndExpiry(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	dir := t.TempDir()
	packGraft(t, dir, "notes", "1.0.0", true, "")
	key := newKey(t)
	p := newPublisher(bucket)
	p.signKey = key

	if _, err := p.runGrafts(context.Background(), []string{dir}, "https://assets.example/registry", ""); err != nil {
		t.Fatal(err)
	}
	body := fake.objects["grafts/index.json"].body
	sig := fake.objects["grafts/index.json.sig"].body
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || !ed25519.Verify(key.Public().(ed25519.PublicKey), body, raw) {
		t.Fatalf("signature does not verify over the published bytes: %v", err)
	}
	var cat graftCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatal(err)
	}
	if cat.Sequence != p.now().Unix() {
		t.Fatalf("sequence %d", cat.Sequence)
	}
	if cat.ExpiresAt != p.now().Add(defaultIndexTTL).UTC().Format(time.RFC3339) {
		t.Fatalf("expiresAt %q", cat.ExpiresAt)
	}

	later := newPublisher(bucket)
	later.signKey = key
	later.now = func() time.Time { return p.now().Add(time.Hour) }
	if _, err := later.runGrafts(context.Background(), []string{dir}, "https://assets.example/registry", ""); err != nil {
		t.Fatal(err)
	}
	var next graftCatalog
	json.Unmarshal(fake.objects["grafts/index.json"].body, &next)
	if next.Sequence <= cat.Sequence {
		t.Fatalf("sequence did not increase: %d then %d", cat.Sequence, next.Sequence)
	}
}

func TestIndexWithoutKeyIsPublishedUnsignedWithoutFreshnessFields(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	dir := t.TempDir()
	packGraft(t, dir, "notes", "1.0.0", true, "")
	if _, err := newPublisher(bucket).runGrafts(context.Background(), []string{dir}, "https://assets.example/registry", ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.objects["grafts/index.json.sig"]; ok {
		t.Fatal("no key, no signature")
	}
	if strings.Contains(string(fake.objects["grafts/index.json"].body), "sequence") {
		t.Fatal("unsigned index should not carry sequence")
	}
}

func TestSyncCommunitySignsTheCatalogWhenItHasAKey(t *testing.T) {
	fake, bucket, _, _ := setup(t)
	gh := newFakeGitHub(t)
	orchard, author := newKey(t), newKey(t)
	listings := t.TempDir()
	writeListing(t, listings, "notes", "acme/orchard-notes", "acme", author)
	gh.release("acme/orchard-notes", "v1.0.0", map[string][]byte{"notes-1.0.0.graft": sealGraft(t, graftFiles("notes", "1.0.0", "", nil), author)})
	s := newCommunitySync(bucket, gh, orchard)
	s.p.signKey = orchard
	if _, err := s.run(context.Background(), listings, ""); err != nil {
		t.Fatal(err)
	}
	body := fake.objects["grafts/index.json"].body
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(fake.objects["grafts/index.json.sig"].body)))
	if err != nil || !ed25519.Verify(orchard.Public().(ed25519.PublicKey), body, raw) {
		t.Fatalf("catalog signature missing or wrong: %v", err)
	}
	var cat graftCatalog
	json.Unmarshal(body, &cat)
	if cat.Sequence == 0 || cat.ExpiresAt == "" {
		t.Fatalf("missing freshness fields: %+v", cat)
	}
}

func TestStampIsEmptyWithoutAKey(t *testing.T) {
	if seq, exp := newPublisher(nil).stamp(); seq != 0 || exp != "" {
		t.Fatalf("%d %q", seq, exp)
	}
}
