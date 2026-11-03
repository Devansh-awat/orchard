package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	mrand "math/rand/v2"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Client mirrors server/src/mcp/client.ts: a thin Bearer-authenticated wrapper
// over the Orchard REST API mounted under /apiv1.
type Client struct {
	BaseURL string
	Token   string
	http    *http.Client
	stream  *http.Client
}

type APIError struct {
	Status  int
	Message string

	retryAfter time.Duration
}

func (e *APIError) Error() string {
	return fmt.Sprintf("orchard api error (%d): %s", e.Status, e.Message)
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
		stream: &http.Client{Transport: &http.Transport{
			ResponseHeaderTimeout: 30 * time.Second,
		}},
	}
}

const maxRetries = 3

// Do performs a request against /apiv1<path> and returns the raw response body.
// body may be nil. It is used directly by the `orchard api` escape hatch.
// GETs retry on 429 (honoring Retry-After) and 5xx; mutations never retry.
func (c *Client) Do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		data, err := c.once(ctx, method, path, body)
		if err == nil || method != http.MethodGet || attempt >= maxRetries {
			return data, err
		}
		apiErr, ok := err.(*APIError)
		if !ok || (apiErr.Status != http.StatusTooManyRequests && apiErr.Status < 500) {
			return data, err
		}
		select {
		case <-time.After(retryDelay(apiErr, attempt)):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func retryDelay(e *APIError, attempt int) time.Duration {
	if e.retryAfter > 0 {
		return e.retryAfter
	}
	base := time.Second << attempt
	return base + time.Duration(mrand.Int64N(int64(base/2)))
}

func (c *Client) once(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	req, err := c.newRequest(ctx, method, path, bodyReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Idempotency-Key", idempotencyKey())
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errorFrom(res, data)
	}
	return data, nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+"/apiv1"+path, body)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func idempotencyKey() string {
	if k := strings.TrimSpace(os.Getenv("ORCHARD_IDEMPOTENCY_KEY")); k != "" {
		return k
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("cli-%d", time.Now().UnixNano())
	}
	return "cli-" + hex.EncodeToString(b)
}

func bodyReader(body []byte) io.Reader {
	if body == nil {
		return nil
	}
	return bytes.NewReader(body)
}

func errorFrom(res *http.Response, data []byte) *APIError {
	e := &APIError{Status: res.StatusCode, Message: extractMessage(data)}
	if s := res.Header.Get("Retry-After"); s != "" {
		if secs, err := strconv.Atoi(s); err == nil && secs > 0 {
			e.retryAfter = time.Duration(secs) * time.Second
		}
	}
	return e
}

func extractMessage(data []byte) string {
	if len(data) == 0 {
		return "(empty response)"
	}
	var m struct {
		Message json.RawMessage `json:"message"`
		Error   string          `json:"error"`
	}
	if json.Unmarshal(data, &m) == nil {
		if len(m.Message) > 0 {
			var s string
			if json.Unmarshal(m.Message, &s) == nil {
				return s
			}
			return string(m.Message)
		}
		if m.Error != "" {
			return m.Error
		}
	}
	return string(data)
}

// GetJSON decodes a GET response into out.
func (c *Client) GetJSON(ctx context.Context, path string, out any) error {
	data, err := c.Do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// Send marshals in (if non-nil) and decodes the response into out (if non-nil).
func (c *Client) Send(ctx context.Context, method, path string, in, out any) error {
	var body []byte
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = b
	}
	data, err := c.Do(ctx, method, path, body)
	if err != nil {
		return err
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// Upload POSTs r as a multipart file field (avatars, project icons). The part
// carries a real content type derived from the filename: the server's multer
// allowlists validate part mimetype, and CreateFormFile's hardcoded
// octet-stream gets rejected.
func (c *Client) Upload(ctx context.Context, path, field, filename string, r io.Reader) ([]byte, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, filename))
	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(filename)))
	if ct == "" {
		ct = "application/octet-stream"
	}
	hdr.Set("Content-Type", ct)
	part, err := w.CreatePart(hdr)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, r); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}

	req, err := c.newRequest(ctx, http.MethodPost, path, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, errorFrom(res, data)
	}
	return data, nil
}
