package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func waitServer(t *testing.T, path string, handler func(call int64, w http.ResponseWriter)) (*Client, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1"+path {
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		handler(calls.Add(1), w)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "orch_test"), &calls
}

func TestWaitForPollsUntilSuccess(t *testing.T) {
	statuses := []string{"building", "building", "running"}
	cl, calls := waitServer(t, "/deployments/1", func(call int64, w http.ResponseWriter) {
		fmt.Fprintf(w, `{"status":%q}`, statuses[call-1])
	})

	var progress []string
	status, err := cl.WaitFor(context.Background(), WaitSpec{
		Path:     "/deployments/1",
		Field:    "status",
		Success:  []string{"running"},
		Failure:  []string{"failed"},
		Interval: 5 * time.Millisecond,
		Timeout:  2 * time.Second,
		Progress: func(s string) { progress = append(progress, s) },
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != "running" {
		t.Errorf("status = %q, want %q", status, "running")
	}
	if got := calls.Load(); got != 3 {
		t.Errorf("polled %d times, want 3", got)
	}
	if want := []string{"building", "running"}; !reflect.DeepEqual(progress, want) {
		t.Errorf("progress = %v, want %v (transitions only)", progress, want)
	}
}

func TestWaitForFailureStatus(t *testing.T) {
	cl, _ := waitServer(t, "/deployments/2", func(_ int64, w http.ResponseWriter) {
		fmt.Fprint(w, `{"status":"failed"}`)
	})

	status, err := cl.WaitFor(context.Background(), WaitSpec{
		Path:     "/deployments/2",
		Field:    "status",
		Success:  []string{"running"},
		Failure:  []string{"failed"},
		Interval: 5 * time.Millisecond,
		Timeout:  time.Second,
	})
	if err == nil {
		t.Fatal("expected an error for failure status")
	}
	if !strings.Contains(err.Error(), "failed") {
		t.Errorf("error %q does not mention the status", err)
	}
	if status != "failed" {
		t.Errorf("status = %q, want %q", status, "failed")
	}
}

func TestWaitForTimeout(t *testing.T) {
	cl, _ := waitServer(t, "/deployments/3", func(_ int64, w http.ResponseWriter) {
		fmt.Fprint(w, `{"status":"building"}`)
	})

	status, err := cl.WaitFor(context.Background(), WaitSpec{
		Path:     "/deployments/3",
		Field:    "status",
		Success:  []string{"running"},
		Failure:  []string{"failed"},
		Interval: 10 * time.Millisecond,
		Timeout:  30 * time.Millisecond,
	})
	if !errors.Is(err, ErrWaitTimeout) {
		t.Fatalf("err = %v, want ErrWaitTimeout", err)
	}
	if status != "building" {
		t.Errorf("status = %q, want last seen %q", status, "building")
	}
}

func TestWaitForCaseInsensitiveStatus(t *testing.T) {
	cl, _ := waitServer(t, "/deployments/4", func(_ int64, w http.ResponseWriter) {
		fmt.Fprint(w, `{"status":"Running"}`)
	})

	status, err := cl.WaitFor(context.Background(), WaitSpec{
		Path:     "/deployments/4",
		Field:    "status",
		Success:  []string{"running"},
		Interval: 5 * time.Millisecond,
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != "Running" {
		t.Errorf("status = %q, want original casing %q", status, "Running")
	}
}

func TestWaitForNestedField(t *testing.T) {
	cl, _ := waitServer(t, "/deployments/5", func(_ int64, w http.ResponseWriter) {
		fmt.Fprint(w, `{"build":{"status":"succeeded"}}`)
	})

	status, err := cl.WaitFor(context.Background(), WaitSpec{
		Path:     "/deployments/5",
		Field:    "build.status",
		Success:  []string{"succeeded"},
		Interval: 5 * time.Millisecond,
		Timeout:  time.Second,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != "succeeded" {
		t.Errorf("status = %q, want %q", status, "succeeded")
	}
}

func TestDig(t *testing.T) {
	tests := []struct {
		name string
		v    any
		path string
		want any
	}{
		{"top-level key", map[string]any{"status": "ok"}, "status", "ok"},
		{"dot path", map[string]any{"a": map[string]any{"b": "x"}}, "a.b", "x"},
		{"missing top key", map[string]any{"a": "x"}, "b", nil},
		{"missing nested key", map[string]any{"a": map[string]any{"b": "x"}}, "a.c", nil},
		{"non-map traversal", map[string]any{"a": "x"}, "a.b", nil},
		{"non-map root", "str", "a", nil},
		{"nil root", nil, "a", nil},
		{"raw message string", map[string]any{"s": json.RawMessage(`"hi"`)}, "s", "hi"},
		{"non-string leaf", map[string]any{"n": 3.0}, "n", 3.0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := dig(tt.v, tt.path); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("dig(%v, %q) = %v, want %v", tt.v, tt.path, got, tt.want)
			}
		})
	}
}
