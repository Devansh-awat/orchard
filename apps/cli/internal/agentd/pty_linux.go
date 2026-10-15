//go:build linux

package agentd

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openPTY(uid, gid int, rows, cols uint16) (*os.File, *os.File, error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	master := os.NewFile(uintptr(fd), "/dev/ptmx")
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("unlock pty: %w", err)
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN)
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("pty number: %w", err)
	}
	name := fmt.Sprintf("/dev/pts/%d", n)
	if uid >= 0 {
		_ = os.Chown(name, uid, gid)
	}
	sfd, err := unix.Open(name, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		master.Close()
		return nil, nil, fmt.Errorf("open %s: %w", name, err)
	}
	slave := os.NewFile(uintptr(sfd), name)
	_ = unix.IoctlSetWinsize(sfd, unix.TIOCSWINSZ, &unix.Winsize{Row: rows, Col: cols})
	return master, slave, nil
}
