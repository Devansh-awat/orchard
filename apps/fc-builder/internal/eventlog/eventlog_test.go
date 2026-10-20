package eventlog

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

func TestFollowStreamsUntilClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.ndjson")
	l, err := Create(path)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- l.Follow(context.Background(), 0, &buf, nil) }()
	l.Append(proto.Log("build", "one"))
	time.Sleep(20 * time.Millisecond)
	l.Append(proto.Result(nil, nil))
	l.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(buf.String(), "\n"); got != 2 {
		t.Fatalf("lines: %d (%q)", got, buf.String())
	}
}

func TestFollowResumesFromOffset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.ndjson")
	l, _ := Create(path)
	l.Append(proto.Log("build", "first"))
	off := l.Size()
	l.Append(proto.Log("build", "second"))
	l.Close()
	var buf bytes.Buffer
	if err := l.Follow(context.Background(), off, &buf, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "first") || !strings.Contains(buf.String(), "second") {
		t.Fatalf("resume wrong: %q", buf.String())
	}
}

func TestFollowStopsOnCancel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.ndjson")
	l, _ := Create(path)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- l.Follow(ctx, 0, &bytes.Buffer{}, nil) }()
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("follow did not stop")
	}
}

func TestLastResultAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "b.ndjson")
	l, _ := Create(path)
	l.Append(proto.Log("build", "x"))
	l.Close()
	ev, err := LastResult(path)
	if err != nil || ev != nil {
		t.Fatalf("expected no result, got %v %v", ev, err)
	}
	reopened, err := OpenClosed(path)
	if err != nil || !reopened.Closed() || reopened.Size() == 0 {
		t.Fatalf("reopen: %v", err)
	}
}
