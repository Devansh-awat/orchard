package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func rolloutServer(t *testing.T, phases []string) (*Client, *atomic.Int64, *atomic.Value) {
	t.Helper()
	var calls atomic.Int64
	var lastQuery atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/apiv1/deployments/d1/rollout" {
			t.Errorf("unexpected path %q", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		lastQuery.Store(r.URL.RawQuery)
		n := calls.Add(1)
		phase := phases[min(int(n), len(phases))-1]
		terminal := phase != "building" && phase != "deploying" && phase != "queued"
		fmt.Fprintf(w, `{"phase":%q,"terminal":%t,"releaseId":null,"url":"https://x.dev","build":{"status":"x","step":null,"error":"line one\nline two","logTail":[]},"pods":{"desired":1,"ready":0,"failing":[]},"hint":null}`, phase, terminal)
	}))
	t.Cleanup(srv.Close)
	return New(srv.URL, "orch_test"), &calls, &lastQuery
}

func TestWaitRolloutFollowsPhasesToLive(t *testing.T) {
	cl, calls, q := rolloutServer(t, []string{"building", "deploying", "live"})
	var seen []string
	r, err := cl.WaitRollout(context.Background(), RolloutWaitSpec{
		DeploymentID: "d1",
		Pin:          RolloutPin{Since: "2026-10-27T12:00:00Z"},
		Timeout:      5 * time.Second,
		RequestWait:  10 * time.Second,
		MinInterval:  time.Millisecond,
		Progress:     func(r *Rollout) { seen = append(seen, r.Phase) },
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Phase != "live" || r.URL != "https://x.dev" {
		t.Errorf("rollout = %+v", r)
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d, want 3", calls.Load())
	}
	if strings.Join(seen, ",") != "building,deploying,live" {
		t.Errorf("progress = %v", seen)
	}
	query := q.Load().(string)
	for _, want := range []string{"wait=1", "timeout=5", "since=2026-10-27T12%3A00%3A00Z"} {
		if !strings.Contains(query, want) {
			t.Errorf("query %q missing %q", query, want)
		}
	}
}

func TestWaitRolloutBuildFailureIsDeployFailed(t *testing.T) {
	cl, _, _ := rolloutServer(t, []string{"build_failed"})
	r, err := cl.WaitRollout(context.Background(), RolloutWaitSpec{DeploymentID: "d1", Timeout: time.Second})
	if !errors.Is(err, ErrDeployFailed) {
		t.Fatalf("err = %v, want ErrDeployFailed", err)
	}
	if r == nil || r.Phase != "build_failed" {
		t.Fatalf("rollout = %+v", r)
	}
	if err.Error() != "build failed: line one" {
		t.Errorf("error = %q", err.Error())
	}
}

func TestWaitRolloutUnhealthyIsDeployCrashing(t *testing.T) {
	cl, _, _ := rolloutServer(t, []string{"unhealthy"})
	_, err := cl.WaitRollout(context.Background(), RolloutWaitSpec{DeploymentID: "d1", Timeout: time.Second})
	if !errors.Is(err, ErrDeployCrashing) {
		t.Fatalf("err = %v, want ErrDeployCrashing", err)
	}
}

func TestWaitRolloutStoppedIsSuccess(t *testing.T) {
	cl, _, _ := rolloutServer(t, []string{"stopped"})
	r, err := cl.WaitRollout(context.Background(), RolloutWaitSpec{DeploymentID: "d1", Timeout: time.Second})
	if err != nil || r.Phase != "stopped" {
		t.Fatalf("rollout = %+v, err = %v", r, err)
	}
}

func TestWaitRolloutTimesOut(t *testing.T) {
	cl, _, _ := rolloutServer(t, []string{"building"})
	r, err := cl.WaitRollout(context.Background(), RolloutWaitSpec{
		DeploymentID: "d1",
		Timeout:      50 * time.Millisecond,
		MinInterval:  10 * time.Millisecond,
	})
	if !errors.Is(err, ErrWaitTimeout) {
		t.Fatalf("err = %v, want ErrWaitTimeout", err)
	}
	if r == nil || r.Phase != "building" {
		t.Fatalf("last rollout = %+v", r)
	}
}

func TestPinFromMutationResponse(t *testing.T) {
	p := PinFrom(map[string]any{"rolloutSince": "2026-10-27T12:00:00Z", "releaseId": "r1"})
	if p.Since != "2026-10-27T12:00:00Z" || p.Release != "r1" {
		t.Errorf("pin = %+v", p)
	}
	if got := PinFrom(map[string]any{"releaseId": nil}); got != (RolloutPin{}) {
		t.Errorf("pin from nulls = %+v", got)
	}
	if path := RolloutPath("a b", RolloutPin{Release: "r1"}, 0); path != "/deployments/a%20b/rollout?release=r1" {
		t.Errorf("path = %q", path)
	}
}

func TestWaitRolloutSurvivesADroppedConnection(t *testing.T) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		fmt.Fprint(w, `{"phase":"live","terminal":true,"url":"https://x.dev"}`)
	}))
	t.Cleanup(srv.Close)
	r, err := New(srv.URL, "orch_test").WaitRollout(context.Background(), RolloutWaitSpec{DeploymentID: "d1", Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("a dropped connection should be retried: %v", err)
	}
	if r.Phase != "live" || calls.Load() != 2 {
		t.Fatalf("phase %q after %d calls", r.Phase, calls.Load())
	}
}
