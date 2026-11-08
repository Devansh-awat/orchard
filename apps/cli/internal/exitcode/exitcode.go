package exitcode

import (
	"context"
	"errors"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/output"
)

// Stable exit codes, documented in `orchard help exit-codes` and AGENTS.md.
const (
	OK             = 0
	Generic        = 1
	Usage          = 2
	Auth           = 3
	NotFound       = 4
	Invalid        = 5
	RateLimited    = 6
	Server         = 7
	Deadline       = 8
	DeployFailed   = 9
	DeployCrashing = 10
	ChecksFailed   = 11
	Interrupted    = 130
)

// ErrChecksFailed marks a health report with at least one failing check.
var ErrChecksFailed = errors.New("one or more checks failed")

// UsageError marks bad invocations (unknown flags, refused prompts) → exit 2.
type UsageError struct{ Err error }

func (e *UsageError) Error() string { return e.Err.Error() }
func (e *UsageError) Unwrap() error { return e.Err }

func FromError(err error) int {
	if err == nil {
		return OK
	}
	var usage *UsageError
	if errors.As(err, &usage) || errors.Is(err, output.ErrPromptRefused) {
		return Usage
	}
	if errors.Is(err, context.Canceled) {
		return Interrupted
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, api.ErrWaitTimeout) {
		return Deadline
	}
	if errors.Is(err, api.ErrDeployFailed) {
		return DeployFailed
	}
	if errors.Is(err, api.ErrDeployCrashing) {
		return DeployCrashing
	}
	if errors.Is(err, ErrChecksFailed) {
		return ChecksFailed
	}
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.Status == 401:
			return Auth
		case apiErr.Status == 404:
			return NotFound
		case apiErr.Status == 429:
			return RateLimited
		case apiErr.Status >= 500:
			return Server
		case apiErr.Status >= 400:
			return Invalid
		}
	}
	return Generic
}
