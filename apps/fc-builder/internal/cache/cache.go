package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

var unsafeChars = regexp.MustCompile(`[^a-z0-9-]+`)

type Policy struct {
	MaxAge    time.Duration
	HighPct   int
	TargetPct int
	MinIdle   time.Duration
}

type Usage struct {
	Total uint64
	Used  uint64
}

type Store struct {
	dir     string
	size    string
	mkfs    func(path, size string) error
	statfs  func(dir string) (Usage, error)
	now     func() time.Time
	mu      sync.Mutex
	pending map[string]*sync.Mutex
}

func New(dir, size string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{dir: dir, size: size, mkfs: makeImage, statfs: diskUsage, now: time.Now, pending: map[string]*sync.Mutex{}}, nil
}

func Key(tenant string) string {
	clean := strings.Trim(unsafeChars.ReplaceAllString(strings.ToLower(tenant), "-"), "-")
	if len(clean) > 48 {
		clean = clean[:48]
	}
	sum := sha256.Sum256([]byte(tenant))
	return clean + "-" + hex.EncodeToString(sum[:4])
}

func (s *Store) Path(tenant string) string {
	return filepath.Join(s.dir, Key(tenant)+".ext4")
}

func (s *Store) lockFor(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.pending[key]
	if !ok {
		m = &sync.Mutex{}
		s.pending[key] = m
	}
	return m
}

func (s *Store) Ensure(tenant string) (string, bool, error) {
	key := Key(tenant)
	m := s.lockFor(key)
	m.Lock()
	defer m.Unlock()
	path := filepath.Join(s.dir, key+".ext4")
	if _, err := os.Stat(path); err == nil {
		s.Touch(tenant)
		return path, false, nil
	}
	tmp := path + ".tmp"
	os.Remove(tmp)
	if err := s.mkfs(tmp, s.size); err != nil {
		os.Remove(tmp)
		return "", false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", false, err
	}
	os.WriteFile(filepath.Join(s.dir, key+".tenant"), []byte(tenant), 0o644)
	s.Touch(tenant)
	return path, true, nil
}

func (s *Store) Touch(tenant string) {
	now := s.now()
	path := filepath.Join(s.dir, Key(tenant)+".used")
	if err := os.WriteFile(path, nil, 0o644); err == nil {
		os.Chtimes(path, now, now)
	}
}

type entry struct {
	key    string
	tenant string
	used   time.Time
}

func (s *Store) entries() []entry {
	matches, _ := filepath.Glob(filepath.Join(s.dir, "*.ext4"))
	var out []entry
	for _, img := range matches {
		key := strings.TrimSuffix(filepath.Base(img), ".ext4")
		e := entry{key: key}
		if b, err := os.ReadFile(filepath.Join(s.dir, key+".tenant")); err == nil {
			e.tenant = string(b)
		}
		if st, err := os.Stat(filepath.Join(s.dir, key+".used")); err == nil {
			e.used = st.ModTime()
		} else if st, err := os.Stat(img); err == nil {
			e.used = st.ModTime()
		}
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].used.Before(out[j].used) })
	return out
}

func (s *Store) Tenants() []string {
	var out []string
	for _, e := range s.entries() {
		if e.tenant != "" {
			out = append(out, e.tenant)
		}
	}
	return out
}

func (s *Store) Usage() (Usage, error) {
	return s.statfs(s.dir)
}

func (s *Store) remove(e entry) {
	m := s.lockFor(e.key)
	m.Lock()
	defer m.Unlock()
	for _, ext := range []string{".ext4", ".used", ".tenant"} {
		os.Remove(filepath.Join(s.dir, e.key+ext))
	}
}

func (s *Store) Evict(p Policy, inUse func(tenant string) bool) []string {
	now := s.now()
	var removed []string
	keep := func(e entry) bool {
		if e.tenant != "" && inUse(e.tenant) {
			return true
		}
		return now.Sub(e.used) < p.MinIdle
	}
	all := s.entries()
	var survivors []entry
	for _, e := range all {
		if !keep(e) && p.MaxAge > 0 && now.Sub(e.used) > p.MaxAge {
			s.remove(e)
			removed = append(removed, e.key)
			continue
		}
		survivors = append(survivors, e)
	}
	u, err := s.statfs(s.dir)
	if err != nil || u.Total == 0 || p.HighPct <= 0 {
		return removed
	}
	if u.Used*100 < u.Total*uint64(p.HighPct) {
		return removed
	}
	for _, e := range survivors {
		u, err = s.statfs(s.dir)
		if err != nil || u.Used*100 <= u.Total*uint64(p.TargetPct) {
			break
		}
		if keep(e) {
			continue
		}
		s.remove(e)
		removed = append(removed, e.key)
	}
	if len(removed) > 0 {
		log.Printf("[fc-builder] cache: evicted %d tenant images", len(removed))
	}
	return removed
}

func makeImage(path, size string) error {
	if out, err := exec.Command("truncate", "-s", size, path).CombinedOutput(); err != nil {
		return fmt.Errorf("truncate: %v: %s", err, out)
	}
	out, err := exec.Command("mkfs.ext4", "-q", "-F", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1", "-L", "fccache", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mkfs.ext4: %v: %s", err, out)
	}
	return nil
}

func diskUsage(dir string) (Usage, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return Usage{}, err
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	return Usage{Total: total, Used: total - free}, nil
}
