package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/LeafdTK/leaf/cli/internal/api"
)

func itemIDs(items []map[string]any) []string {
	ids := []string{}
	for _, m := range items {
		ids = append(ids, pick(m, "id"))
	}
	return ids
}

func TestFetchPagedSinglePage(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantIDs    []string
		wantCursor string
	}{
		{"items with nextCursor", `{"items":[{"id":"a"},{"id":"b"}],"nextCursor":"abc"}`, []string{"a", "b"}, "abc"},
		{"wrapped data key", `{"data":[{"id":"x"},{"id":"y"}]}`, []string{"x", "y"}, ""},
		{"null nextCursor", `{"items":[{"id":"a"}],"nextCursor":null}`, []string{"a"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/apiv1/widgets" {
					w.WriteHeader(404)
					return
				}
				io.WriteString(w, tt.body)
			}))
			defer srv.Close()

			cl := api.New(srv.URL, "tok")
			items, cursor, err := fetchPaged(context.Background(), cl, "/widgets", nil, 50, "", false)
			if err != nil {
				t.Fatalf("fetchPaged: %v", err)
			}
			if got := itemIDs(items); !reflect.DeepEqual(got, tt.wantIDs) {
				t.Errorf("items = %v, want %v", got, tt.wantIDs)
			}
			if cursor != tt.wantCursor {
				t.Errorf("cursor = %q, want %q", cursor, tt.wantCursor)
			}
		})
	}
}

func TestFetchPagedAllFollowsCursors(t *testing.T) {
	var gotCursors []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/widgets" {
			w.WriteHeader(404)
			return
		}
		c := r.URL.Query().Get("cursor")
		gotCursors = append(gotCursors, c)
		switch c {
		case "":
			io.WriteString(w, `{"items":[{"id":"a"}],"nextCursor":"c1"}`)
		case "c1":
			io.WriteString(w, `{"items":[{"id":"b"}],"nextCursor":"c2"}`)
		case "c2":
			io.WriteString(w, `{"items":[{"id":"c"}]}`)
		default:
			w.WriteHeader(400)
		}
	}))
	defer srv.Close()

	cl := api.New(srv.URL, "tok")
	items, cursor, err := fetchPaged(context.Background(), cl, "/widgets", nil, 50, "", true)
	if err != nil {
		t.Fatalf("fetchPaged: %v", err)
	}
	if got := itemIDs(items); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("items = %v, want [a b c]", got)
	}
	if cursor != "" {
		t.Errorf("final cursor = %q, want empty", cursor)
	}
	if !reflect.DeepEqual(gotCursors, []string{"", "c1", "c2"}) {
		t.Errorf("server saw cursors %v, want [\"\" c1 c2]", gotCursors)
	}
}

func TestFetchPagedQueryParams(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		io.WriteString(w, `{"items":[]}`)
	}))
	defer srv.Close()

	cl := api.New(srv.URL, "tok")
	q := url.Values{"projectId": {"p1"}}
	if _, _, err := fetchPaged(context.Background(), cl, "/widgets", q, 25, "resume", false); err != nil {
		t.Fatalf("fetchPaged: %v", err)
	}
	if got := gotQuery.Get("limit"); got != "25" {
		t.Errorf("limit = %q, want 25", got)
	}
	if got := gotQuery.Get("cursor"); got != "resume" {
		t.Errorf("cursor = %q, want resume", got)
	}
	if got := gotQuery.Get("projectId"); got != "p1" {
		t.Errorf("projectId = %q, want p1", got)
	}
}

func TestFetchPagedSafetyCap(t *testing.T) {
	var requests int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		io.WriteString(w, `{"items":[{"id":"n"}],"nextCursor":"loop"}`)
	}))
	defer srv.Close()

	cl := api.New(srv.URL, "tok")
	items, cursor, err := fetchPaged(context.Background(), cl, "/widgets", nil, 50, "", true)
	if err == nil {
		t.Fatal("expected safety-cap error, got nil")
	}
	if !strings.Contains(err.Error(), "safety cap") {
		t.Errorf("error = %q, want it to mention the safety cap", err)
	}
	if requests != maxPages {
		t.Errorf("server saw %d requests, want %d", requests, maxPages)
	}
	if len(items) != maxPages {
		t.Errorf("collected %d items before cap, want %d", len(items), maxPages)
	}
	if cursor != "loop" {
		t.Errorf("cursor at cap = %q, want loop", cursor)
	}
}
