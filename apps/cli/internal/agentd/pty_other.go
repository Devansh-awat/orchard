//go:build !linux && !windows

package agentd

import (
	"errors"
	"os"
)

func openPTY(uid, gid int, rows, cols uint16) (*os.File, *os.File, error) {
	return nil, nil, errors.New("signing in to an agent needs a Linux machine")
}
