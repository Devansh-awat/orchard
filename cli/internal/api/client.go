package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client mirrors server/src/mcp/client.ts: a thin Bearer-authenticated wrapper
// over the Orchard REST API mounted under /apiv1.
type Client struct {
	BaseURL string
	Token   string
	http    *http.Client
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("orchard api error (%d): %s", e.Status, e.Message)
}

func New(baseURL, token string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

// Do performs a request against /apiv1<path> and returns the raw response body.
// body may be nil. It is used directly by the `orchard api` escape hatch.
func (c *Client) Do(method, path string, body []byte) ([]byte, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	url := c.BaseURL + "/apiv1" + path

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

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
		return nil, &APIError{Status: res.StatusCode, Message: extractMessage(data)}
	}
	return data, nil
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
func (c *Client) GetJSON(path string, out any) error {
	data, err := c.Do(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// Send marshals in (if non-nil) and decodes the response into out (if non-nil).
func (c *Client) Send(method, path string, in, out any) error {
	var body []byte
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = b
	}
	data, err := c.Do(method, path, body)
	if err != nil {
		return err
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}
