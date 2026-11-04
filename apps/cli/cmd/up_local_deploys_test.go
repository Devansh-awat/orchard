package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
)

func TestLocalDeploysHintExplainsDisabledServer(t *testing.T) {
	err := localDeploysHint(&api.APIError{
		Status:  400,
		Message: "Local deploys are disabled on this server (set LOCAL_DEPLOYS_ENABLED=true and configure R2_BUILD_CONTEXT_BUCKET)",
	})
	if !strings.Contains(err.Error(), "orchard up is off on this server") {
		t.Errorf("error = %q, want the hint", err)
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 400 {
		t.Errorf("error %v lost the API error, so the exit code would change", err)
	}
}

func TestLocalDeploysHintLeavesOtherErrorsAlone(t *testing.T) {
	want := &api.APIError{Status: 403, Message: "forbidden"}
	if got := localDeploysHint(want); got != error(want) {
		t.Errorf("error = %v, want it unchanged", got)
	}
	plain := errors.New("network down")
	if got := localDeploysHint(plain); got != plain {
		t.Errorf("error = %v, want it unchanged", got)
	}
}
