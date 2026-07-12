package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func sseWrite(w http.ResponseWriter, id, data string) {
	if id != "" {
		fmt.Fprintf(w, "id: %s\n", id)
	}
	for _, line := range strings.Split(data, "\n") {
		fmt.Fprintf(w, "data: %s\n", line)
	}
	fmt.Fprint(w, "\n")
	w.(http.Flusher).Flush()
}

func recvEvent(t *testing.T, events <-chan OrgEvent) OrgEvent {
	t.Helper()
	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("events channel closed unexpectedly")
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for event")
	}
	return OrgEvent{}
}

func TestSubscribeOrgEventsParsesFrames(t *testing.T) {
	auth := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/events/orgs/org1" {
			w.WriteHeader(404)
			return
		}
		auth <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		sseWrite(w, "1-1", `{"organizationId":"org1","type":"heartbeat"}`)
		// payload is split mid-object: only a real "\n" join keeps the raw
		// bytes verbatim in Payload; plain concatenation would erase it.
		sseWrite(w, "1-2", `{"organizationId":"org1","type":"deploy.updated","id":"d1","projectId":"p1","ts":42,"payload":{"a":1,`+"\n"+`"b":2}}`)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, _ := New(srv.URL, "orch_tok").SubscribeOrgEvents(ctx, "org1", "")

	ev := recvEvent(t, events)
	if ev.Type != "deploy.updated" {
		t.Fatalf("heartbeat not skipped, got type %q", ev.Type)
	}
	if ev.EventID != "1-2" {
		t.Fatalf("event id = %q, want 1-2", ev.EventID)
	}
	if ev.OrganizationID != "org1" || ev.ID != "d1" || ev.ProjectID != "p1" || ev.TS != 42 {
		t.Fatalf("bad event fields: %+v", ev)
	}
	if got := string(ev.Payload); got != "{\"a\":1,\n\"b\":2}" {
		t.Fatalf("multi-line data not joined with newline, payload = %q", got)
	}
	if a := <-auth; a != "Bearer orch_tok" {
		t.Fatalf("auth header = %q", a)
	}
}

func TestSubscribeOrgEventsReconnectResumes(t *testing.T) {
	urls := make(chan string, 4)
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urls <- r.URL.String()
		w.Header().Set("Content-Type", "text/event-stream")
		if conns.Add(1) == 1 {
			sseWrite(w, "1-1", `{"organizationId":"org1","type":"deploy.created"}`)
			sseWrite(w, "1-2", `{"organizationId":"org1","type":"deploy.updated"}`)
			return
		}
		sseWrite(w, "1-3", `{"organizationId":"org1","type":"deploy.deleted"}`)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, errs := New(srv.URL, "tok").SubscribeOrgEvents(ctx, "org1", "")

	if u := <-urls; strings.Contains(u, "lastEventId") {
		t.Fatalf("first connect should not carry lastEventId, got %q", u)
	}
	if ev := recvEvent(t, events); ev.EventID != "1-1" {
		t.Fatalf("event id = %q, want 1-1", ev.EventID)
	}
	if ev := recvEvent(t, events); ev.EventID != "1-2" {
		t.Fatalf("event id = %q, want 1-2", ev.EventID)
	}

	start := time.Now()
	select {
	case u := <-urls:
		if !strings.HasSuffix(u, "?lastEventId=1-2") {
			t.Fatalf("reconnect url = %q, want ?lastEventId=1-2", u)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no reconnect within 5s")
	}
	// first reconnect delay is 1s + jitter up to 500ms
	if d := time.Since(start); d < 900*time.Millisecond {
		t.Fatalf("reconnected after %v, expected ~1s backoff", d)
	}

	select {
	case <-errs:
	default:
	}
	if ev := recvEvent(t, events); ev.EventID != "1-3" {
		t.Fatalf("event id = %q, want 1-3", ev.EventID)
	}
}

func TestSubscribeOrgEventsInitialLastEventID(t *testing.T) {
	urls := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		urls <- r.URL.String()
		w.Header().Set("Content-Type", "text/event-stream")
		sseWrite(w, "9-1", `{"organizationId":"org1","type":"deploy.created"}`)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, _ := New(srv.URL, "tok").SubscribeOrgEvents(ctx, "org1", "42-0")

	if u := <-urls; !strings.HasSuffix(u, "?lastEventId=42-0") {
		t.Fatalf("first connect url = %q, want ?lastEventId=42-0", u)
	}
	if ev := recvEvent(t, events); ev.EventID != "9-1" {
		t.Fatalf("event id = %q, want 9-1", ev.EventID)
	}
}

func TestSubscribeOrgEventsContextCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		sseWrite(w, "1-1", `{"organizationId":"org1","type":"deploy.created"}`)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	events, errs := New(srv.URL, "tok").SubscribeOrgEvents(ctx, "org1", "")

	recvEvent(t, events)
	cancel()

	deadline := time.After(2 * time.Second)
	for events != nil || errs != nil {
		select {
		case _, ok := <-events:
			if !ok {
				events = nil
			}
		case _, ok := <-errs:
			if !ok {
				errs = nil
			}
		case <-deadline:
			t.Fatal("channels did not close after cancel")
		}
	}
}
