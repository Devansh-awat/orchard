package buildctx

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/moby/patternmatcher"
)

// MaxContextBytes caps the gzipped tarball (matches the server's limit).
const MaxContextBytes = 100 * 1024 * 1024

// alwaysExcluded are stripped regardless of ignore files: VCS state, the
// orchard link dir, and local env files that must never ride into a build.
var alwaysExcluded = []string{".git", ".orchard", ".env.orchard"}

// Pack tars dir (gzipped) honoring .dockerignore when present, else
// .gitignore. Returns the archive bytes and the number of files included.
func Pack(dir string) ([]byte, int, error) {
	matcher, source, err := loadIgnore(dir)
	if err != nil {
		return nil, 0, err
	}
	if source != "" {
		fmt.Fprintln(os.Stderr, "using "+source+" to filter the build context")
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	files := 0

	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(dir, path)
		if rerr != nil {
			return rerr
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)

		base := rel
		if i := strings.Index(rel, "/"); i >= 0 {
			base = rel[:i]
		}
		for _, ex := range alwaysExcluded {
			if base == ex || rel == ex {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		if matcher != nil {
			ignored, merr := matcher.MatchesOrParentMatches(rel)
			if merr != nil {
				return merr
			}
			if ignored {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		info, ierr := d.Info()
		if ierr != nil {
			return ierr
		}
		if !info.Mode().IsRegular() && !d.IsDir() && info.Mode()&fs.ModeSymlink == 0 {
			return nil
		}

		link := ""
		if info.Mode()&fs.ModeSymlink != 0 {
			link, _ = os.Readlink(path)
		}
		hdr, herr := tar.FileInfoHeader(info, link)
		if herr != nil {
			return herr
		}
		hdr.Name = rel
		if d.IsDir() {
			hdr.Name += "/"
		}
		if werr := tw.WriteHeader(hdr); werr != nil {
			return werr
		}
		if info.Mode().IsRegular() {
			f, ferr := os.Open(path)
			if ferr != nil {
				return ferr
			}
			_, cerr := io.Copy(tw, f)
			f.Close()
			if cerr != nil {
				return cerr
			}
			files++
		}
		if buf.Len() > MaxContextBytes {
			return errors.New("build context exceeds 100MB; add a .dockerignore to exclude build artifacts (node_modules, dist, ...)")
		}
		return nil
	})
	if walkErr != nil {
		return nil, 0, walkErr
	}
	if err := tw.Close(); err != nil {
		return nil, 0, err
	}
	if err := gz.Close(); err != nil {
		return nil, 0, err
	}
	if buf.Len() > MaxContextBytes {
		return nil, 0, errors.New("build context exceeds 100MB; add a .dockerignore to exclude build artifacts")
	}
	return buf.Bytes(), files, nil
}

func loadIgnore(dir string) (*patternmatcher.PatternMatcher, string, error) {
	for _, name := range []string{".dockerignore", ".gitignore"} {
		patterns, err := readIgnoreFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		if len(patterns) == 0 {
			continue
		}
		m, merr := patternmatcher.New(patterns)
		if merr != nil {
			return nil, "", fmt.Errorf("invalid patterns in %s: %w", name, merr)
		}
		return m, name, nil
	}
	return nil, "", nil
}

func readIgnoreFile(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var patterns []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}
	return patterns, sc.Err()
}
