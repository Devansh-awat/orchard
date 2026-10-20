package cache

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) (*Store, *time.Time, *Usage) {
	s, err := New(t.TempDir(), "1G")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	usage := &Usage{Total: 100, Used: 10}
	s.now = func() time.Time { return now }
	s.mkfs = func(path, size string) error { return os.WriteFile(path, []byte("img"), 0o644) }
	s.statfs = func(string) (Usage, error) {
		n, _ := filepath.Glob(filepath.Join(s.dir, "*.ext4"))
		return Usage{Total: usage.Total, Used: usage.Used + uint64(len(n))*10}, nil
	}
	return s, &now, usage
}

func TestKeyIsStableAndSafe(t *testing.T) {
	a, b := Key("Proj_Fudge/../x"), Key("Proj_Fudge/../x")
	if a != b {
		t.Fatal("unstable")
	}
	if filepath.Base(a) != a || a == "" {
		t.Fatalf("unsafe key %q", a)
	}
	if Key("a-b") == Key("a_b") {
		t.Fatal("collision between tenants that sanitize alike")
	}
}

func TestEnsureCreatesOnce(t *testing.T) {
	s, _, _ := testStore(t)
	p1, created, err := s.Ensure("proj-a")
	if err != nil || !created {
		t.Fatalf("first: %v %v", created, err)
	}
	p2, created, err := s.Ensure("proj-a")
	if err != nil || created || p1 != p2 {
		t.Fatalf("second: %v %v %s", created, err, p2)
	}
	if got := s.Tenants(); len(got) != 1 || got[0] != "proj-a" {
		t.Fatalf("tenants: %v", got)
	}
}

func TestEvictByAgeSkipsInUseAndRecent(t *testing.T) {
	s, now, _ := testStore(t)
	s.Ensure("old")
	s.Ensure("busy")
	*now = now.Add(20 * 24 * time.Hour)
	s.Ensure("fresh")
	removed := s.Evict(Policy{MaxAge: 14 * 24 * time.Hour, MinIdle: time.Hour}, func(t string) bool { return t == "busy" })
	if len(removed) != 1 || removed[0] != Key("old") {
		t.Fatalf("removed %v", removed)
	}
	if _, err := os.Stat(s.Path("busy")); err != nil {
		t.Fatal("evicted an in-use tenant")
	}
}

func TestEvictLRUUnderPressure(t *testing.T) {
	s, now, usage := testStore(t)
	for _, tn := range []string{"a", "b", "c", "d"} {
		s.Ensure(tn)
		*now = now.Add(2 * time.Hour)
	}
	usage.Used = 50
	removed := s.Evict(Policy{HighPct: 80, TargetPct: 60, MinIdle: time.Hour}, func(string) bool { return false })
	if len(removed) != 3 || removed[0] != Key("a") || removed[1] != Key("b") || removed[2] != Key("c") {
		t.Fatalf("removed %v", removed)
	}
}

func TestEvictNothingBelowHighWater(t *testing.T) {
	s, now, _ := testStore(t)
	s.Ensure("a")
	*now = now.Add(48 * time.Hour)
	if removed := s.Evict(Policy{HighPct: 80, TargetPct: 60, MinIdle: time.Hour}, func(string) bool { return false }); len(removed) != 0 {
		t.Fatalf("removed %v", removed)
	}
}
