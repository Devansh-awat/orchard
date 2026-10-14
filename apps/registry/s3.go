package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const emptyPayloadSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

type Bucket struct {
	Endpoint  string
	Region    string
	Name      string
	AccessKey string
	SecretKey string
	Client    *http.Client
}

type Object struct {
	Key          string
	ETag         string
	Size         int64
	LastModified time.Time
}

var ErrNotFound = errors.New("object not found")

func (b *Bucket) objectURL(key string) string {
	return strings.TrimSuffix(b.Endpoint, "/") + "/" + b.Name + "/" + canonicalURI(key)
}

func (b *Bucket) newRequest(ctx context.Context, method, key string, query url.Values, body []byte) (*http.Request, error) {
	target := b.objectURL(key)
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	return req, nil
}

func (b *Bucket) do(req *http.Request, payloadSha string) (*http.Response, error) {
	signRequest(req, b.AccessKey, b.SecretKey, b.Region, "s3", payloadSha)
	client := b.Client
	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(req)
}

func (b *Bucket) Get(ctx context.Context, key string, headers http.Header) (*http.Response, error) {
	req, err := b.newRequest(ctx, http.MethodGet, key, nil, nil)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"If-None-Match", "If-Modified-Since", "Range"} {
		if v := headers.Get(name); v != "" {
			req.Header.Set(name, v)
		}
	}
	return b.do(req, emptyPayloadSha)
}

func (b *Bucket) Head(ctx context.Context, key string) (*Object, error) {
	req, err := b.newRequest(ctx, http.MethodHead, key, nil, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.do(req, emptyPayloadSha)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("head %s: %s", key, resp.Status)
	}
	obj := &Object{Key: key, ETag: resp.Header.Get("ETag"), Size: resp.ContentLength}
	if t, err := http.ParseTime(resp.Header.Get("Last-Modified")); err == nil {
		obj.LastModified = t
	}
	return obj, nil
}

func (b *Bucket) ReadAll(ctx context.Context, key string) ([]byte, error) {
	resp, err := b.Get(ctx, key, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get %s: %s", key, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func (b *Bucket) Put(ctx context.Context, key string, body []byte, contentType, cacheControl string) error {
	req, err := b.newRequest(ctx, http.MethodPut, key, nil, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	if cacheControl != "" {
		req.Header.Set("Cache-Control", cacheControl)
	}
	sum := sha256.Sum256(body)
	resp, err := b.do(req, hex.EncodeToString(sum[:]))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("put %s: %s", key, resp.Status)
	}
	return nil
}

func md5ETag(body []byte) string {
	sum := md5.Sum(body)
	return `"` + hex.EncodeToString(sum[:]) + `"`
}

func sha256Hex(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func canonicalURI(p string) string {
	if p == "" {
		return ""
	}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = uriEscape(s, false)
	}
	return strings.Join(segs, "/")
}

func canonicalQuery(q string) string {
	if q == "" {
		return ""
	}
	type kv struct{ k, v string }
	var kvs []kv
	for _, p := range strings.Split(q, "&") {
		if p == "" {
			continue
		}
		k, v, _ := strings.Cut(p, "=")
		kvs = append(kvs, kv{k: uriEscape(percentDecode(k), true), v: uriEscape(percentDecode(v), true)})
	}
	sort.Slice(kvs, func(i, j int) bool {
		if kvs[i].k == kvs[j].k {
			return kvs[i].v < kvs[j].v
		}
		return kvs[i].k < kvs[j].k
	})
	var b strings.Builder
	for i, p := range kvs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(p.k)
		b.WriteByte('=')
		b.WriteString(p.v)
	}
	return b.String()
}

func uriEscape(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '_', c == '-', c == '~', c == '.':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func percentDecode(s string) string {
	out, err := url.QueryUnescape(s)
	if err != nil {
		return s
	}
	return out
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func deriveSigningKey(secret, date, region, service string) []byte {
	k := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	k = hmacSHA256(k, []byte(region))
	k = hmacSHA256(k, []byte(service))
	return hmacSHA256(k, []byte("aws4_request"))
}

func signRequest(req *http.Request, ak, sk, region, service, payloadSha string) {
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateOnly := now.Format("20060102")

	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadSha)

	signed := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	for name := range req.Header {
		lower := strings.ToLower(name)
		switch {
		case lower == "x-amz-date", lower == "x-amz-content-sha256":
		case strings.HasPrefix(lower, "x-amz-"), lower == "content-type", lower == "range":
			signed = append(signed, lower)
		}
	}
	sort.Strings(signed)

	var canonHeaders strings.Builder
	for _, h := range signed {
		canonHeaders.WriteString(h)
		canonHeaders.WriteByte(':')
		if h == "host" {
			canonHeaders.WriteString(strings.ToLower(req.Host))
		} else {
			canonHeaders.WriteString(strings.TrimSpace(req.Header.Get(h)))
		}
		canonHeaders.WriteByte('\n')
	}

	canonical := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL.Path),
		canonicalQuery(req.URL.RawQuery),
		canonHeaders.String(),
		strings.Join(signed, ";"),
		payloadSha,
	}, "\n")

	scope := dateOnly + "/" + region + "/" + service + "/aws4_request"
	toSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonical))}, "\n")
	sig := hex.EncodeToString(hmacSHA256(deriveSigningKey(sk, dateOnly, region, service), []byte(toSign)))
	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		ak, scope, strings.Join(signed, ";"), sig,
	))
}

func (b *Bucket) List(ctx context.Context, prefix string) ([]Object, error) {
	var out []Object
	token := ""
	for {
		query := url.Values{"list-type": {"2"}, "prefix": {prefix}}
		if token != "" {
			query.Set("continuation-token", token)
		}
		req, err := b.newRequest(ctx, http.MethodGet, "", query, nil)
		if err != nil {
			return nil, err
		}
		resp, err := b.do(req, emptyPayloadSha)
		if err != nil {
			return nil, err
		}
		var page struct {
			Contents []struct {
				Key  string `xml:"Key"`
				ETag string `xml:"ETag"`
				Size int64  `xml:"Size"`
			} `xml:"Contents"`
			IsTruncated           bool   `xml:"IsTruncated"`
			NextContinuationToken string `xml:"NextContinuationToken"`
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("list %s: %s", prefix, resp.Status)
		}
		err = xml.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", prefix, err)
		}
		for _, c := range page.Contents {
			out = append(out, Object{Key: c.Key, ETag: c.ETag, Size: c.Size})
		}
		if !page.IsTruncated || page.NextContinuationToken == "" {
			return out, nil
		}
		token = page.NextContinuationToken
	}
}
