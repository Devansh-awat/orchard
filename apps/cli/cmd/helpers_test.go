package cmd

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/cli/internal/api"
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

func TestDiffAppend(t *testing.T) {
	tests := []struct{ name, prev, cur, want string }{
		{"empty prev emits everything", "", "a\nb\n", "a\nb\n"},
		{"both empty", "", "", ""},
		{"identical", "a\nb\n", "a\nb\n", ""},
		{"growing log", "a\nb\n", "a\nb\nc\n", "c\n"},
		{"slid tail window", "a\nb\nc\n", "b\nc\nd\n", "d\n"},
		{"slid past all but one anchor line", "a\nb\nc\n", "c\nd\ne\n", "d\ne\n"},
		{"rotation emits whole", "a\nb\nc\n", "x\ny\nz\n", "x\ny\nz\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := diffAppend(tt.prev, tt.cur); got != tt.want {
				t.Errorf("diffAppend(%q, %q) = %q, want %q", tt.prev, tt.cur, got, tt.want)
			}
		})
	}
}

func TestFollowLinesEmitsOnlyNewLines(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// scripted fetch sequence: initial tail, no change, growth, slid window;
	// once exhausted the fetch cancels the ctx so followLines returns nil.
	seq := []string{"a\nb\n", "a\nb\n", "a\nb\nc\n", "b\nc\nd\n"}
	calls := 0
	var buf strings.Builder
	fetch := func(context.Context) (string, error) {
		if calls >= len(seq) {
			cancel()
			return seq[len(seq)-1], nil
		}
		s := seq[calls]
		calls++
		return s, nil
	}
	if err := followLines(ctx, time.Millisecond, fetch, &buf); err != nil {
		t.Fatalf("followLines: %v", err)
	}
	if got, want := buf.String(), "a\nb\nc\nd\n"; got != want {
		t.Errorf("output = %q, want %q", got, want)
	}
	if calls != len(seq) {
		t.Errorf("fetch calls = %d, want %d", calls, len(seq))
	}
}

func TestFollowLinesPropagatesFetchError(t *testing.T) {
	boom := errors.New("boom")
	err := followLines(context.Background(), time.Millisecond, func(context.Context) (string, error) {
		return "", boom
	}, io.Discard)
	if !errors.Is(err, boom) {
		t.Errorf("err = %v, want %v", err, boom)
	}
}

func TestFollowLinesFetchErrorAfterCancelIsClean(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	first := true
	err := followLines(ctx, time.Millisecond, func(context.Context) (string, error) {
		if first {
			first = false
			return "a\n", nil
		}
		cancel()
		return "", context.Canceled
	}, io.Discard)
	if err != nil {
		t.Errorf("err = %v, want nil (Ctrl-C must exit 0)", err)
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
