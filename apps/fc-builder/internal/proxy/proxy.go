package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
)

var (
	repoName  = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$`)
	tailSegment = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._:+=-]*$`)
	resources = []string{"/blobs/", "/manifests/", "/tags/", "/referrers/"}
	hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}
)

type challenge struct {
	scheme  string
	realm   string
	service string
}

type token struct {
	value   string
	expires time.Time
}

type Proxy struct {
	upstream  *url.URL
	user      string
	pass      string
	transport http.RoundTripper
	now       func() time.Time

	mu     sync.Mutex
	grants map[int]map[string]int
	tokens map[string]token
	chal   *challenge
}

func New(upstream, user, pass string) (*Proxy, error) {
	u, err := url.Parse(strings.TrimRight(upstream, "/"))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid upstream registry %q", upstream)
	}
	if u.Scheme == "" {
		u.Scheme = "http"
	}
	return &Proxy{
		upstream: u,
		user:     user,
		pass:     pass,
		transport: &http.Transport{
			Proxy:               nil,
			MaxIdleConnsPerHost: 64,
			IdleConnTimeout:     90 * time.Second,
		},
		now:    time.Now,
		grants: map[int]map[string]int{},
		tokens: map[string]token{},
	}, nil
}

func ValidRepository(name string) bool {
	return len(name) <= 255 && repoName.MatchString(name)
}

func (p *Proxy) Grant(slot int, repo string) (func(), error) {
	if !ValidRepository(repo) {
		return nil, fmt.Errorf("invalid repository %q", repo)
	}
	p.mu.Lock()
	if p.grants[slot] == nil {
		p.grants[slot] = map[string]int{}
	}
	p.grants[slot][repo]++
	p.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			defer p.mu.Unlock()
			if m := p.grants[slot]; m != nil {
				if m[repo]--; m[repo] <= 0 {
					delete(m, repo)
				}
				if len(m) == 0 {
					delete(p.grants, slot)
				}
			}
		})
	}, nil
}

func (p *Proxy) allowed(slot int, repo string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.grants[slot][repo] > 0
}

func splitRepo(path string) (string, bool) {
	rest, ok := strings.CutPrefix(path, "/v2/")
	if !ok {
		return "", false
	}
	cut := -1
	for _, r := range resources {
		if i := strings.LastIndex(rest, r); i > 0 && (cut < 0 || i < cut) {
			cut = i
		}
	}
	if cut < 0 {
		return "", false
	}
	name := rest[:cut]
	if !ValidRepository(name) || !validTail(rest[cut+1:]) {
		return "", false
	}
	return name, true
}

func validTail(tail string) bool {
	segments := strings.Split(tail, "/")
	for i, seg := range segments {
		if seg == "" && i == len(segments)-1 && i > 0 {
			continue
		}
		if !tailSegment.MatchString(seg) {
			return false
		}
	}
	return true
}

func deny(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"errors": []map[string]string{{"code": code, "message": msg}}})
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		deny(w, http.StatusForbidden, "DENIED", "unknown client")
		return
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		deny(w, http.StatusForbidden, "DENIED", "unknown client")
		return
	}
	slot, ok := netsetup.SlotForGuest(ip)
	if !ok {
		deny(w, http.StatusForbidden, "DENIED", "unknown client")
		return
	}
	if r.URL.Path == "/v2/" || r.URL.Path == "/v2" {
		w.Header().Set("Docker-Distribution-API-Version", "registry/2.0")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "{}")
		return
	}
	repo, ok := splitRepo(r.URL.Path)
	if !ok {
		deny(w, http.StatusForbidden, "DENIED", "unsupported registry path")
		return
	}
	if !p.allowed(slot, repo) {
		log.Printf("[fc-builder] proxy: slot %d denied %s %s", slot, r.Method, repo)
		deny(w, http.StatusForbidden, "DENIED", "repository not granted to this build")
		return
	}
	query := r.URL.Query()
	if r.Method == http.MethodPost && query.Get("mount") != "" {
		if from := query.Get("from"); from == "" || !p.allowed(slot, from) {
			query.Del("mount")
			query.Del("from")
		}
	}
	p.forward(w, r, repo, query.Encode())
}

func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, repo, rawQuery string) {
	retryable := r.Method == http.MethodGet || r.Method == http.MethodHead
	for attempt := 0; ; attempt++ {
		auth, err := p.authorization(r.Context(), repo)
		if err != nil {
			log.Printf("[fc-builder] proxy: auth for %s: %v", repo, err)
			deny(w, http.StatusBadGateway, "UNAVAILABLE", "registry authentication failed")
			return
		}
		out := r.Clone(r.Context())
		out.RequestURI = ""
		out.URL = &url.URL{Scheme: p.upstream.Scheme, Host: p.upstream.Host, Path: p.upstream.Path + r.URL.Path, RawQuery: rawQuery}
		out.Host = p.upstream.Host
		for _, h := range hopHeaders {
			out.Header.Del(h)
		}
		out.Header.Del("Authorization")
		if auth != "" {
			out.Header.Set("Authorization", auth)
		}
		if attempt > 0 {
			out.Body = http.NoBody
		}
		resp, err := p.transport.RoundTrip(out)
		if err != nil {
			deny(w, http.StatusBadGateway, "UNAVAILABLE", "registry unreachable")
			return
		}
		if resp.StatusCode == http.StatusUnauthorized {
			p.dropToken(repo)
			if retryable && attempt == 0 {
				resp.Body.Close()
				continue
			}
			resp.Body.Close()
			deny(w, http.StatusBadGateway, "UNAVAILABLE", "registry rejected credentials")
			return
		}
		p.copyResponse(w, resp)
		return
	}
}

func (p *Proxy) copyResponse(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	resp.Header.Del("Www-Authenticate")
	if loc := resp.Header.Get("Location"); loc != "" {
		if u, err := url.Parse(loc); err == nil && u.IsAbs() && strings.EqualFold(u.Host, p.upstream.Host) {
			rel := &url.URL{Path: strings.TrimPrefix(u.Path, p.upstream.Path), RawQuery: u.RawQuery}
			resp.Header.Set("Location", rel.String())
		}
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func (p *Proxy) dropToken(repo string) {
	p.mu.Lock()
	delete(p.tokens, repo)
	p.mu.Unlock()
}

func (p *Proxy) authorization(ctx context.Context, repo string) (string, error) {
	chal, err := p.discover(ctx)
	if err != nil {
		return "", err
	}
	switch chal.scheme {
	case "":
		return "", nil
	case "basic":
		req, _ := http.NewRequest(http.MethodGet, "/", nil)
		req.SetBasicAuth(p.user, p.pass)
		return req.Header.Get("Authorization"), nil
	}
	p.mu.Lock()
	tok, ok := p.tokens[repo]
	p.mu.Unlock()
	if ok && p.now().Before(tok.expires) {
		return "Bearer " + tok.value, nil
	}
	tok, err = p.fetchToken(ctx, chal, repo)
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	p.tokens[repo] = tok
	p.mu.Unlock()
	return "Bearer " + tok.value, nil
}

func (p *Proxy) discover(ctx context.Context) (*challenge, error) {
	p.mu.Lock()
	if p.chal != nil {
		c := p.chal
		p.mu.Unlock()
		return c, nil
	}
	p.mu.Unlock()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.upstream.String()+"/v2/", nil)
	resp, err := p.transport.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	c := &challenge{}
	if resp.StatusCode == http.StatusUnauthorized {
		c, err = parseChallenge(resp.Header.Get("Www-Authenticate"))
		if err != nil {
			return nil, err
		}
	}
	p.mu.Lock()
	p.chal = c
	p.mu.Unlock()
	return c, nil
}

func parseChallenge(h string) (*challenge, error) {
	scheme, params, _ := strings.Cut(strings.TrimSpace(h), " ")
	c := &challenge{scheme: strings.ToLower(scheme)}
	if c.scheme == "basic" {
		return c, nil
	}
	if c.scheme != "bearer" {
		return nil, fmt.Errorf("unsupported auth challenge %q", h)
	}
	for _, part := range splitParams(params) {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"`)
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "realm":
			c.realm = v
		case "service":
			c.service = v
		}
	}
	if c.realm == "" {
		return nil, errors.New("bearer challenge without realm")
	}
	return c, nil
}

func splitParams(s string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	for _, ch := range s {
		switch {
		case ch == '"':
			quoted = !quoted
			cur.WriteRune(ch)
		case ch == ',' && !quoted:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(ch)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func (p *Proxy) fetchToken(ctx context.Context, c *challenge, repo string) (token, error) {
	realm, err := url.Parse(c.realm)
	if err != nil {
		return token{}, err
	}
	realm.Scheme = p.upstream.Scheme
	realm.Host = p.upstream.Host
	q := realm.Query()
	if c.service != "" {
		q.Set("service", c.service)
	}
	q.Set("scope", "repository:"+repo+":pull,push")
	realm.RawQuery = q.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	req.SetBasicAuth(p.user, p.pass)
	resp, err := p.transport.RoundTrip(req)
	if err != nil {
		return token{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return token{}, fmt.Errorf("token endpoint returned %d", resp.StatusCode)
	}
	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return token{}, err
	}
	value := body.Token
	if value == "" {
		value = body.AccessToken
	}
	if value == "" {
		return token{}, errors.New("token endpoint returned no token")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	if ttl > 20*time.Second {
		ttl -= 15 * time.Second
	}
	return token{value: value, expires: p.now().Add(ttl)}, nil
}
