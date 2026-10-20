package cgroups

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const Mount = "/sys/fs/cgroup"

type Tree struct {
	Mount string
	Self  string
}

func Own(procCgroup string) (string, error) {
	b, err := os.ReadFile(procCgroup)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if rest, ok := strings.CutPrefix(line, "0::"); ok {
			return rest, nil
		}
	}
	return "", errors.New("not on cgroup v2")
}

func (t Tree) dir(parts ...string) string {
	return filepath.Join(append([]string{t.Mount, t.Self}, parts...)...)
}

func (t Tree) VMParent() string {
	return strings.TrimPrefix(filepath.Join(t.Self, "vms"), "/")
}

func (t Tree) VMDir(id string) string {
	return t.dir("vms", id)
}

func (t Tree) Nest(controllers ...string) error {
	for _, d := range []string{t.dir("host"), t.dir("vms")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	enable := make([]string, len(controllers))
	for i, c := range controllers {
		enable[i] = "+" + c
	}
	var last error
	for range 5 {
		if err := t.moveProcs(); err != nil {
			return err
		}
		last = os.WriteFile(t.dir("cgroup.subtree_control"), []byte(strings.Join(enable, " ")), 0o644)
		if last == nil {
			return nil
		}
	}
	return fmt.Errorf("enable %v below %s: %w", controllers, t.Self, last)
}

func (t Tree) moveProcs() error {
	b, err := os.ReadFile(t.dir("cgroup.procs"))
	if err != nil {
		return err
	}
	for _, pid := range strings.Fields(string(b)) {
		if err := os.WriteFile(t.dir("host", "cgroup.procs"), []byte(pid), 0o644); err != nil && !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "no such process") {
			return fmt.Errorf("move pid %s: %w", pid, err)
		}
	}
	return nil
}

func readLimit(path string) (int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return n, err == nil
}

func (t Tree) MemoryMax() (int64, bool) {
	return readLimit(t.dir("memory.max"))
}

func (t Tree) Uncommitted() int64 {
	entries, err := os.ReadDir(t.dir("vms"))
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		limit, ok := readLimit(t.dir("vms", e.Name(), "memory.max"))
		if !ok {
			continue
		}
		used, _ := readLimit(t.dir("vms", e.Name(), "memory.current"))
		if limit > used {
			total += limit - used
		}
	}
	return total
}

func MemAvailable(meminfo string) (int64, error) {
	f, err := os.Open(meminfo)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if rest, ok := strings.CutPrefix(s.Text(), "MemAvailable:"); ok {
			kb, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimSpace(rest), " kB"), 10, 64)
			if err != nil {
				return 0, err
			}
			return kb * 1024, nil
		}
	}
	return 0, errors.New("MemAvailable missing from " + meminfo)
}

func FitVMs(want int, podMax, perVM, reserve int64) int {
	if podMax <= 0 || perVM <= 0 {
		return want
	}
	fit := int((podMax - reserve) / perVM)
	return max(min(want, fit), 0)
}
