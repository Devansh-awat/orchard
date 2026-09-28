package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const defaultIconSource = "https://www.google.com/s2/favicons?domain=%s&sz=256"

type IconFetcher struct {
	Source string
	Client *http.Client
}

type Icon struct {
	Body        []byte
	ContentType string
	From        string
}

var (
	linkTagRe = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	attrRe    = regexp.MustCompile(`(?is)([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	sizesRe   = regexp.MustCompile(`(\d+)x(\d+)`)
	wellKnown = []string{"/apple-touch-icon.png", "/apple-touch-icon-180x180.png", "/android-chrome-512x512.png", "/android-chrome-192x192.png", "/favicon.svg", "/icon.svg", "/favicon-196x196.png", "/favicon-192x192.png", "/icon-512.png", "/icon-192.png"}
)

func iconFetcherFromFlag(source string) *IconFetcher {
	if source == "" {
		return nil
	}
	return &IconFetcher{Source: source, Client: &http.Client{Timeout: 20 * time.Second}}
}

func (f *IconFetcher) client() *http.Client {
	if f.Client != nil {
		return f.Client
	}
	return http.DefaultClient
}

func (f *IconFetcher) get(ctx context.Context, target string, limit int64) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; orchard-registry)")
	req.Header.Set("Accept", "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,text/html;q=0.5,application/json;q=0.5,*/*;q=0.1")
	resp, err := f.client().Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("%s: %s", target, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return nil, "", err
	}
	return body, strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])), nil
}

func attrs(tag string) map[string]string {
	out := map[string]string{}
	for _, m := range attrRe.FindAllStringSubmatch(tag, -1) {
		value := m[2]
		if value == "" {
			value = m[3]
		}
		if value == "" {
			value = m[4]
		}
		out[strings.ToLower(m[1])] = strings.TrimSpace(value)
	}
	return out
}

type candidate struct {
	href string
	size int
	rank int
}

func sizeOf(sizes string) int {
	if m := sizesRe.FindStringSubmatch(strings.ToLower(sizes)); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	if strings.EqualFold(strings.TrimSpace(sizes), "any") {
		return 512
	}
	return 0
}

func isSVG(href, typ string) bool {
	return strings.HasSuffix(strings.ToLower(strings.SplitN(href, "?", 2)[0]), ".svg") || strings.Contains(strings.ToLower(typ), "svg")
}

func resolve(base *url.URL, href string) (string, bool) {
	ref, err := url.Parse(strings.TrimSpace(href))
	if err != nil || href == "" {
		return "", false
	}
	return base.ResolveReference(ref).String(), true
}

func iconCandidates(base *url.URL, html string) ([]candidate, []string) {
	var out []candidate
	var manifests []string
	for _, tag := range linkTagRe.FindAllString(html, -1) {
		a := attrs(tag)
		rel := strings.ToLower(a["rel"])
		href, ok := resolve(base, a["href"])
		if !ok {
			continue
		}
		if rel == "manifest" {
			manifests = append(manifests, href)
			continue
		}
		size := sizeOf(a["sizes"])
		var rank int
		switch {
		case strings.Contains(rel, "apple-touch-icon"):
			rank = 3
			if size == 0 {
				size = 180
			}
		case rel == "icon" || strings.Contains(rel, "shortcut icon") || rel == "fluid-icon":
			rank = 2
			if isSVG(href, a["type"]) {
				rank = 4
				size = 512
			} else if strings.HasSuffix(strings.ToLower(strings.SplitN(href, "?", 2)[0]), ".ico") {
				rank = 1
				if size == 0 {
					size = 32
				}
			}
		default:
			continue
		}
		out = append(out, candidate{href: href, size: size, rank: rank})
	}
	return out, manifests
}

func manifestCandidates(base *url.URL, body []byte) []candidate {
	var m struct {
		Icons []struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
			Type  string `json:"type"`
		} `json:"icons"`
	}
	if json.Unmarshal(body, &m) != nil {
		return nil
	}
	var out []candidate
	for _, ic := range m.Icons {
		href, ok := resolve(base, ic.Src)
		if !ok {
			continue
		}
		size := sizeOf(ic.Sizes)
		rank := 3
		if isSVG(href, ic.Type) {
			rank = 4
			size = 512
		}
		out = append(out, candidate{href: href, size: size, rank: rank})
	}
	return out
}

func pick(cands []candidate) []candidate {
	for i := 0; i < len(cands); i++ {
		for j := i + 1; j < len(cands); j++ {
			a, b := cands[i], cands[j]
			if b.size > a.size || (b.size == a.size && b.rank > a.rank) {
				cands[i], cands[j] = cands[j], cands[i]
			}
		}
	}
	return cands
}

func (f *IconFetcher) Fetch(ctx context.Context, explicit, homepage string) (*Icon, error) {
	if strings.HasPrefix(explicit, "http://") || strings.HasPrefix(explicit, "https://") {
		if icon, err := f.image(ctx, explicit); err == nil {
			return icon, nil
		}
	}
	u, err := url.Parse(homepage)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("no host in homepage %q", homepage)
	}
	if strings.EqualFold(u.Host, "github.com") {
		if parts := strings.Split(strings.Trim(u.Path, "/"), "/"); len(parts) >= 1 && parts[0] != "" {
			if icon, err := f.image(ctx, "https://github.com/"+parts[0]+".png?size=256"); err == nil {
				return icon, nil
			}
		}
	}
	var cands []candidate
	if html, ctype, err := f.get(ctx, homepage, 2<<20); err == nil && strings.Contains(ctype, "html") {
		var manifests []string
		cands, manifests = iconCandidates(u, string(html))
		for _, m := range manifests {
			if body, _, err := f.get(ctx, m, 1<<20); err == nil {
				mu, _ := url.Parse(m)
				cands = append(cands, manifestCandidates(mu, body)...)
			}
		}
	}
	for _, path := range wellKnown {
		href, _ := resolve(u, path)
		cands = append(cands, candidate{href: href, size: 64, rank: 0})
	}
	for _, c := range pick(cands) {
		if c.size < 64 {
			break
		}
		if icon, err := f.image(ctx, c.href); err == nil {
			return icon, nil
		}
	}
	return f.image(ctx, fmt.Sprintf(f.Source, url.QueryEscape(u.Host)))
}

func (f *IconFetcher) image(ctx context.Context, target string) (*Icon, error) {
	body, ctype, err := f.get(ctx, target, 2<<20)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(ctype, "image/") {
		return nil, fmt.Errorf("%s: not an image (%s)", target, ctype)
	}
	if len(body) < 64 {
		return nil, fmt.Errorf("%s: empty image", target)
	}
	return &Icon{Body: body, ContentType: ctype, From: target}, nil
}

func iconArtifactName(ctype string) string {
	switch ctype {
	case "image/svg+xml":
		return "icon.svg"
	case "image/jpeg":
		return "icon.jpg"
	case "image/webp":
		return "icon.webp"
	case "image/x-icon", "image/vnd.microsoft.icon":
		return "icon.ico"
	default:
		return "icon.png"
	}
}
