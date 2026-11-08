package exitcode

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
)

func TestFromError(t *testing.T) {
	usage := &UsageError{Err: errors.New("unknown flag: --frobnicate")}
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"nil", nil, OK},
		{"plain error", errors.New("boom"), Generic},
		{"usage error", usage, Usage},
		{"usage error wrapped", fmt.Errorf("deploy: %w", usage), Usage},
		{"prompt refused", output.ErrPromptRefused, Usage},
		{"prompt refused wrapped", fmt.Errorf("confirm: %w", output.ErrPromptRefused), Usage},
		{"deadline exceeded", context.DeadlineExceeded, Deadline},
		{"wait timeout", api.ErrWaitTimeout, Deadline},
		{"wait timeout wrapped", fmt.Errorf("waiting for deploy: %w", api.ErrWaitTimeout), Deadline},
		{"canceled", context.Canceled, Interrupted},
		{"canceled wrapped", fmt.Errorf("ctrl-c: %w", context.Canceled), Interrupted},
		{"deploy failed", api.ErrDeployFailed, DeployFailed},
		{"deploy failed wrapped", fmt.Errorf("up: %w", api.ErrDeployFailed), DeployFailed},
		{"deploy crashing", api.ErrDeployCrashing, DeployCrashing},
		{"checks failed", ErrChecksFailed, ChecksFailed},
		{"checks failed wrapped", fmt.Errorf("doctor: %w", ErrChecksFailed), ChecksFailed},
		{"rollout error build", api.RolloutOutcome(&api.Rollout{Phase: "build_failed", Terminal: true}), DeployFailed},
		{"rollout error crashing", api.RolloutOutcome(&api.Rollout{Phase: "crashing", Terminal: true}), DeployCrashing},
		{"rollout error unhealthy", api.RolloutOutcome(&api.Rollout{Phase: "unhealthy", Terminal: true}), DeployCrashing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FromError(tc.err); got != tc.want {
				t.Fatalf("got exit %d, want %d", got, tc.want)
			}
		})
	}
}

func TestFromErrorAPIStatuses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/apiv1/status/"))
		if err != nil {
			t.Errorf("unexpected path %q", r.URL.Path)
			code = 500
		}
		w.WriteHeader(code)
		fmt.Fprintf(w, `{"error":"status %d"}`, code)
	}))
	defer srv.Close()
	client := api.New(srv.URL, "tok")

	cases := []struct {
		status int
		want   int
	}{
		{401, Auth},
		{404, NotFound},
		{400, Invalid},
		{409, Invalid},
		{422, Invalid},
		{429, RateLimited},
		{500, Server},
		{503, Server},
	}
	for _, tc := range cases {
		t.Run(strconv.Itoa(tc.status), func(t *testing.T) {
			// POST so the client never retries (429/5xx retries are GET-only).
			_, err := client.Do(context.Background(), http.MethodPost, "/status/"+strconv.Itoa(tc.status), nil)
			if err == nil {
				t.Fatal("expected an api error")
			}
			if got := FromError(err); got != tc.want {
				t.Fatalf("status %d: got exit %d, want %d", tc.status, got, tc.want)
			}
			if got := FromError(fmt.Errorf("wrapped: %w", err)); got != tc.want {
				t.Fatalf("status %d wrapped: got exit %d, want %d", tc.status, got, tc.want)
			}
		})
	}
}
