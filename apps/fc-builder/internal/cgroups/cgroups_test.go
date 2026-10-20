package cgroups

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestOwnReadsTheUnifiedLine(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cgroup")
	write(t, p, "0::/kubepods/burstable/podabc/ctr1\n")
	got, err := Own(p)
	if err != nil || got != "/kubepods/burstable/podabc/ctr1" {
		t.Fatalf("got %q %v", got, err)
	}
	write(t, p, "12:memory:/foo\n")
	if _, err := Own(p); err == nil {
		t.Fatal("cgroup v1 accepted")
	}
}

func TestNestMovesProcsAndEnablesControllers(t *testing.T) {
	root := t.TempDir()
	tree := Tree{Mount: root, Self: "/kubepods/pod1/ctr"}
	self := filepath.Join(root, "kubepods/pod1/ctr")
	write(t, filepath.Join(self, "cgroup.procs"), "1\n42\n")
	if err := tree.Nest("cpu", "memory"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(self, "host", "cgroup.procs")); got != "42" {
		t.Fatalf("last moved pid %q", got)
	}
	if got := read(t, filepath.Join(self, "cgroup.subtree_control")); got != "+cpu +memory" {
		t.Fatalf("subtree_control %q", got)
	}
	if tree.VMParent() != "kubepods/pod1/ctr/vms" {
		t.Fatalf("parent %q", tree.VMParent())
	}
	if tree.VMDir("vm-0-1") != filepath.Join(self, "vms", "vm-0-1") {
		t.Fatalf("vm dir %q", tree.VMDir("vm-0-1"))
	}
}

func TestUncommittedSumsUntouchedVMMemory(t *testing.T) {
	root := t.TempDir()
	tree := Tree{Mount: root, Self: "/ctr"}
	vms := filepath.Join(root, "ctr", "vms")
	write(t, filepath.Join(vms, "a", "memory.max"), "1000\n")
	write(t, filepath.Join(vms, "a", "memory.current"), "400\n")
	write(t, filepath.Join(vms, "b", "memory.max"), "1000\n")
	write(t, filepath.Join(vms, "b", "memory.current"), "1200\n")
	write(t, filepath.Join(vms, "c", "memory.max"), "max\n")
	if got := tree.Uncommitted(); got != 600 {
		t.Fatalf("uncommitted %d", got)
	}
}

func TestMemoryMax(t *testing.T) {
	root := t.TempDir()
	tree := Tree{Mount: root, Self: "/ctr"}
	write(t, filepath.Join(root, "ctr", "memory.max"), "max\n")
	if _, ok := tree.MemoryMax(); ok {
		t.Fatal("unlimited reported as a limit")
	}
	write(t, filepath.Join(root, "ctr", "memory.max"), "81604378624\n")
	if n, ok := tree.MemoryMax(); !ok || n != 81604378624 {
		t.Fatalf("got %d %v", n, ok)
	}
}

func TestMemAvailable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "meminfo")
	write(t, p, "MemTotal:       263537232 kB\nMemFree:         1000 kB\nMemAvailable:   170813940 kB\n")
	got, err := MemAvailable(p)
	if err != nil || got != 170813940*1024 {
		t.Fatalf("got %d %v", got, err)
	}
}

func TestFitVMs(t *testing.T) {
	gib := int64(1 << 30)
	if got := FitVMs(6, 78*gib, 12*gib+256<<20, 2*gib); got != 6 {
		t.Fatalf("78Gi fits %d", got)
	}
	if got := FitVMs(6, 48*gib, 12*gib+256<<20, 2*gib); got != 3 {
		t.Fatalf("48Gi fits %d", got)
	}
	if got := FitVMs(6, 0, 12*gib, 2*gib); got != 6 {
		t.Fatalf("unlimited fits %d", got)
	}
	if got := FitVMs(6, 8*gib, 12*gib, 2*gib); got != 0 {
		t.Fatalf("tiny pod fits %d", got)
	}
}
