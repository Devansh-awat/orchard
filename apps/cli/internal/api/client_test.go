package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDoGetRetriesOn429HonoringRetryAfter(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()

	cl := New(srv.URL, "tok")
	start := time.Now()
	data, err := cl.Do(context.Background(), http.MethodGet, "/widgets", nil)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	if string(data) != `{"ok":true}` {
		t.Errorf("body = %q, want %q", data, `{"ok":true}`)
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("requests = %d, want 2", got)
	}
	if elapsed := time.Since(start); elapsed < time.Second || elapsed >= 3*time.Second {
		t.Errorf("elapsed = %s, want ~1s retry-after delay", elapsed)
	}
}

func TestDoGetGivesUpAfterMaxRetries(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"message":"boom"}`)
	}))
	defer srv.Close()

	cl := New(srv.URL, "tok")
	_, err := cl.Do(context.Background(), http.MethodGet, "/widgets", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %T (%v), want *APIError", err, err)
	}
	if apiErr.Status != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", apiErr.Status)
	}
	if apiErr.Message != "boom" {
		t.Errorf("message = %q, want %q", apiErr.Message, "boom")
	}
	if got := calls.Load(); got != maxRetries+1 {
		t.Errorf("requests = %d, want %d", got, maxRetries+1)
	}
}

func TestDoPostNeverRetries(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		status int
	}{
		{"429", http.StatusTooManyRequests},
		{"500", http.StatusInternalServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(tt.status)
			}))
			defer srv.Close()

			cl := New(srv.URL, "tok")
			_, err := cl.Do(context.Background(), http.MethodPost, "/widgets", []byte(`{}`))
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("err = %T (%v), want *APIError", err, err)
			}
			if apiErr.Status != tt.status {
				t.Errorf("status = %d, want %d", apiErr.Status, tt.status)
			}
			if got := calls.Load(); got != 1 {
				t.Errorf("requests = %d, want 1", got)
			}
		})
	}
}

func TestExtractMessage(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		data string
		want string
	}{
		{"message string", `{"message":"nope"}`, "nope"},
		{"message array", `{"message":["a is bad","b is worse"]}`, `["a is bad","b is worse"]`},
		{"error field", `{"error":"bad thing"}`, "bad thing"},
		{"raw fallback non-json", "internal server error", "internal server error"},
		{"raw fallback object without fields", `{"code":42}`, `{"code":42}`},
		{"empty", "", "(empty response)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractMessage([]byte(tt.data)); got != tt.want {
				t.Errorf("extractMessage(%q) = %q, want %q", tt.data, got, tt.want)
			}
		})
	}
}

func TestUploadSendsMultipart(t *testing.T) {
	t.Parallel()
	type got struct {
		path     string
		auth     string
		ctype    string
		field    string
		filename string
		content  string
	}
	var g got
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.path = r.URL.Path
		g.auth = r.Header.Get("Authorization")
		g.ctype = r.Header.Get("Content-Type")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f, hdr, err := r.FormFile("icon")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer f.Close()
		g.field = "icon"
		g.filename = hdr.Filename
		b, _ := io.ReadAll(f)
		g.content = string(b)
		io.WriteString(w, `{"uploaded":true}`)
	}))
	defer srv.Close()

	cl := New(srv.URL, "sekret")
	data, err := cl.Upload(context.Background(), "/projects/p1/icon", "icon", "icon.png", strings.NewReader("png-bytes"))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if string(data) != `{"uploaded":true}` {
		t.Errorf("body = %q, want %q", data, `{"uploaded":true}`)
	}
	if g.path != "/apiv1/projects/p1/icon" {
		t.Errorf("path = %q, want %q", g.path, "/apiv1/projects/p1/icon")
	}
	if g.auth != "Bearer sekret" {
		t.Errorf("authorization = %q, want %q", g.auth, "Bearer sekret")
	}
	if !strings.HasPrefix(g.ctype, "multipart/form-data; boundary=") {
		t.Errorf("content-type = %q, want multipart/form-data with boundary", g.ctype)
	}
	if g.filename != "icon.png" {
		t.Errorf("filename = %q, want %q", g.filename, "icon.png")
	}
	if g.content != "png-bytes" {
		t.Errorf("file content = %q, want %q", g.content, "png-bytes")
	}
}

func TestDoRequestShape(t *testing.T) {
	t.Parallel()
	type got struct {
		method string
		path   string
		auth   string
		ctype  string
		accept string
		body   string
	}
	var g got
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.method = r.Method
		g.path = r.URL.Path
		g.auth = r.Header.Get("Authorization")
		g.ctype = r.Header.Get("Content-Type")
		g.accept = r.Header.Get("Accept")
		b, _ := io.ReadAll(r.Body)
		g.body = string(b)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	cl := New(srv.URL+"/", "tok")
	if _, err := cl.Do(context.Background(), http.MethodPut, "widgets/42", []byte(`{"a":1}`)); err != nil {
		t.Fatalf("do: %v", err)
	}
	if g.method != http.MethodPut {
		t.Errorf("method = %q, want %q", g.method, http.MethodPut)
	}
	if g.path != "/apiv1/widgets/42" {
		t.Errorf("path = %q, want %q", g.path, "/apiv1/widgets/42")
	}
	if g.auth != "Bearer tok" {
		t.Errorf("authorization = %q, want %q", g.auth, "Bearer tok")
	}
	if g.ctype != "application/json" {
		t.Errorf("content-type = %q, want %q", g.ctype, "application/json")
	}
	if g.accept != "application/json" {
		t.Errorf("accept = %q, want %q", g.accept, "application/json")
	}
	if g.body != `{"a":1}` {
		t.Errorf("body = %q, want %q", g.body, `{"a":1}`)
	}
}

func TestMutationsSendIdempotencyKey(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("Idempotency-Key"))
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	cl := New(srv.URL, "tok")
	if _, err := cl.Do(context.Background(), http.MethodGet, "/widgets", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := cl.Do(context.Background(), http.MethodPost, "/widgets", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := cl.Do(context.Background(), http.MethodPost, "/widgets", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if got[0] != "" {
		t.Errorf("GET sent Idempotency-Key %q", got[0])
	}
	if !strings.HasPrefix(got[1], "cli-") || got[1] == got[2] {
		t.Errorf("POST keys = %q, %q; want distinct cli- keys", got[1], got[2])
	}

	t.Setenv("ORCHARD_IDEMPOTENCY_KEY", "agent-retry-7")
	if _, err := cl.Do(context.Background(), http.MethodPost, "/widgets", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if got[3] != "agent-retry-7" {
		t.Errorf("env key = %q, want agent-retry-7", got[3])
	}
}
