//go:build linux

package guest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

type Server struct {
	Runner *Runner
	Ready  func(ctx context.Context) error
}

func ListenVsock(port uint32) (int, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return -1, err
	}
	if err := unix.Listen(fd, 64); err != nil {
		unix.Close(fd)
		return -1, err
	}
	return fd, nil
}

func (s *Server) Serve(ctx context.Context, fd int) error {
	for {
		nfd, _, err := unix.Accept4(fd, unix.SOCK_CLOEXEC)
		if err != nil {
			if errors.Is(err, unix.EINTR) || errors.Is(err, unix.ECONNABORTED) {
				continue
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		unix.SetNonblock(nfd, true)
		go s.handle(ctx, os.NewFile(uintptr(nfd), "vsock"))
	}
}

func (s *Server) handle(base context.Context, conn *os.File) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return
	}
	var req proto.GuestRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return
	}
	var mu sync.Mutex
	enc := json.NewEncoder(conn)
	emit := func(ev proto.Event) {
		mu.Lock()
		defer mu.Unlock()
		enc.Encode(ev)
	}
	switch req.Op {
	case proto.OpPing:
		ctx, cancel := context.WithTimeout(base, 5*time.Second)
		defer cancel()
		emit(proto.Result(s.Ready(ctx), nil))
	case proto.OpBuild:
		if req.Build == nil {
			emit(proto.Result(errors.New("missing build"), nil))
			return
		}
		ctx, cancel := context.WithCancel(base)
		defer cancel()
		go func() {
			io.Copy(io.Discard, reader)
			cancel()
		}()
		log.Printf("build %s starting", req.Build.ID)
		timings, err := s.Runner.Run(ctx, *req.Build, emit)
		if err != nil && ctx.Err() != nil && base.Err() == nil {
			err = errors.New("build cancelled")
		}
		emit(proto.Result(err, timings))
		log.Printf("build %s finished: %v", req.Build.ID, err)
	}
}

type Buildkitd struct {
	Args []string
	Addr string

	mu  sync.Mutex
	cmd *exec.Cmd
}

func (b *Buildkitd) Supervise(ctx context.Context) {
	for ctx.Err() == nil {
		cmd := exec.Command("buildkitd", b.Args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		b.mu.Lock()
		b.cmd = cmd
		b.mu.Unlock()
		if err := cmd.Start(); err != nil {
			log.Printf("buildkitd start: %v", err)
		} else {
			cmd.Wait()
		}
		if ctx.Err() != nil {
			return
		}
		log.Printf("buildkitd exited, restarting")
		time.Sleep(time.Second)
	}
}

func (b *Buildkitd) Ready(ctx context.Context) error {
	for {
		cmd := exec.CommandContext(ctx, "buildctl", "--addr", b.Addr, "debug", "workers")
		if cmd.Run() == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("buildkitd not ready")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (b *Buildkitd) Stop(timeout time.Duration) {
	b.mu.Lock()
	cmd := b.cmd
	b.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	cmd.Process.Signal(unix.SIGTERM)
	done := make(chan struct{})
	go func() { cmd.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		cmd.Process.Kill()
	}
}

func PowerOff(cacheMount string) {
	unix.Sync()
	if err := unix.Unmount(cacheMount, 0); err != nil {
		log.Printf("unmount %s: %v", cacheMount, err)
		unix.Sync()
	} else {
		log.Printf("GUEST-CLEAN-SHUTDOWN")
	}
	unix.Reboot(unix.LINUX_REBOOT_CMD_RESTART)
}
