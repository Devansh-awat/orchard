//go:build windows

package agentd

import (
	"context"
	"errors"
	"time"
)

type Options struct {
	TokenFile  string
	User       string
	StateDir   string
	Home       string
	PhaseFile  string
	AgentsFile string
	InitDir    string
	IdleAgent  time.Duration
	Logf       func(format string, args ...any)
}

type Daemon struct{}

var errUnsupported = errors.New("orchard sandbox agentd only runs inside Linux machines")

func New(Options) (*Daemon, error) {
	return nil, errUnsupported
}

func (d *Daemon) ListenAndServe(context.Context, string) error {
	return errUnsupported
}
