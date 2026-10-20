package vm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type FirecrackerLauncher struct {
	Firecracker string
	Jailer      string
	Kernel      string
	Rootfs      string
	JailBase    string
	WorkDir     string
	LogDir      string
	UseJailer   bool
	Cgroups     bool
	CgroupRoot  string
	CgroupBase  string
	MemOverhead int
	IOEngine    string
}

func MemoryLimits(memMiB, overheadMiB int) (high, max int64) {
	if overheadMiB <= 0 {
		overheadMiB = 1536
	}
	return int64(memMiB+overheadMiB/2) << 20, int64(memMiB+overheadMiB) << 20
}

func (l *FirecrackerLauncher) cgroupArgs(spec Spec) []string {
	high, max := MemoryLimits(spec.MemMiB, l.MemOverhead)
	return []string{
		"--cgroup-version", "2",
		"--parent-cgroup", l.cgroupParent(),
		"--cgroup", fmt.Sprintf("cpu.max=%d 100000", spec.VCPUs*100000),
		"--cgroup", fmt.Sprintf("memory.high=%d", high),
		"--cgroup", fmt.Sprintf("memory.max=%d", max),
	}
}

func (l *FirecrackerLauncher) cgroupParent() string {
	if l.CgroupBase == "" {
		return "firecracker"
	}
	return l.CgroupBase
}

type fcInstance struct {
	cmd       *exec.Cmd
	apiSock   string
	vsockSock string
	cleanup   func()
	done      chan struct{}
	killOnce  sync.Once
}

func (l *FirecrackerLauncher) config(spec Spec, kernel, rootfs, cache, vsock string) ([]byte, error) {
	engine := l.IOEngine
	if engine == "" {
		engine = "Async"
	}
	cfg := map[string]any{
		"boot-source": map[string]any{"kernel_image_path": kernel, "boot_args": spec.BootArgs},
		"drives": []map[string]any{
			{"drive_id": "rootfs", "path_on_host": rootfs, "is_root_device": true, "is_read_only": true},
			{"drive_id": "cache", "path_on_host": cache, "is_root_device": false, "is_read_only": false, "io_engine": engine},
		},
		"machine-config": map[string]any{"vcpu_count": spec.VCPUs, "mem_size_mib": spec.MemMiB},
		"network-interfaces": []map[string]any{
			{"iface_id": "eth0", "host_dev_name": spec.Slot.Tap, "guest_mac": spec.Slot.MAC},
		},
		"vsock": map[string]any{"guest_cid": 3, "uds_path": vsock},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func (l *FirecrackerLauncher) Launch(ctx context.Context, spec Spec) (Instance, error) {
	if err := os.MkdirAll(l.LogDir, 0o755); err != nil {
		return nil, err
	}
	logFile, err := os.Create(filepath.Join(l.LogDir, spec.ID+".log"))
	if err != nil {
		return nil, err
	}
	var inst *fcInstance
	if l.UseJailer {
		inst, err = l.launchJailed(spec, logFile)
	} else {
		inst, err = l.launchDirect(spec, logFile)
	}
	if err != nil {
		logFile.Close()
		return nil, err
	}
	go func() {
		inst.cmd.Wait()
		logFile.Close()
		inst.cleanup()
		close(inst.done)
	}()
	return inst, nil
}

func (l *FirecrackerLauncher) launchJailed(spec Spec, out io.Writer) (*fcInstance, error) {
	jailDir := filepath.Join(l.JailBase, "firecracker", spec.ID)
	root := filepath.Join(jailDir, "root")
	os.RemoveAll(jailDir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	for src, dst := range map[string]string{l.Kernel: "vmlinux", l.Rootfs: "rootfs.ext4", spec.CacheImage: "cache.ext4"} {
		if err := os.Link(src, filepath.Join(root, dst)); err != nil {
			os.RemoveAll(jailDir)
			return nil, fmt.Errorf("link %s into jail: %w", src, err)
		}
	}
	if err := os.Chown(spec.CacheImage, spec.UID, spec.UID); err != nil {
		os.RemoveAll(jailDir)
		return nil, err
	}
	cfg, err := l.config(spec, "/vmlinux", "/rootfs.ext4", "/cache.ext4", "/v.sock")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(root, "config.json"), cfg, 0o644); err != nil {
		return nil, err
	}
	args := []string{
		"--id", spec.ID,
		"--exec-file", l.Firecracker,
		"--uid", fmt.Sprint(spec.UID),
		"--gid", fmt.Sprint(spec.UID),
		"--chroot-base-dir", l.JailBase,
	}
	if l.Cgroups {
		args = append(args, l.cgroupArgs(spec)...)
	}
	args = append(args, "--", "--api-sock", "/api.sock", "--config-file", "/config.json")
	cmd := exec.Command(l.Jailer, args...)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		os.RemoveAll(jailDir)
		return nil, fmt.Errorf("start jailer: %w", err)
	}
	return &fcInstance{
		cmd:       cmd,
		apiSock:   filepath.Join(root, "api.sock"),
		vsockSock: filepath.Join(root, "v.sock"),
		done:      make(chan struct{}),
		cleanup: func() {
			os.RemoveAll(jailDir)
			if l.Cgroups {
				os.Remove(filepath.Join(l.CgroupRoot, l.cgroupParent(), spec.ID))
			}
		},
	}, nil
}

func (l *FirecrackerLauncher) launchDirect(spec Spec, out io.Writer) (*fcInstance, error) {
	dir := filepath.Join(l.WorkDir, spec.ID)
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	vsock := filepath.Join(dir, "v.sock")
	cfg, err := l.config(spec, l.Kernel, l.Rootfs, spec.CacheImage, vsock)
	if err != nil {
		return nil, err
	}
	cfgPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(cfgPath, cfg, 0o644); err != nil {
		return nil, err
	}
	api := filepath.Join(dir, "api.sock")
	cmd := exec.Command(l.Firecracker, "--api-sock", api, "--config-file", cfgPath)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("start firecracker: %w", err)
	}
	return &fcInstance{
		cmd:       cmd,
		apiSock:   api,
		vsockSock: vsock,
		done:      make(chan struct{}),
		cleanup:   func() { os.RemoveAll(dir) },
	}, nil
}

func (i *fcInstance) Done() <-chan struct{} {
	return i.done
}

func (i *fcInstance) Kill() {
	i.killOnce.Do(func() {
		if i.cmd.Process != nil {
			i.cmd.Process.Kill()
		}
	})
}

func (i *fcInstance) Dial(ctx context.Context, port uint32) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", i.vsockSock)
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	if _, err := fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, err
	}
	var line []byte
	b := make([]byte, 1)
	for len(line) < 64 {
		if _, err := conn.Read(b); err != nil {
			conn.Close()
			return nil, err
		}
		if b[0] == '\n' {
			break
		}
		line = append(line, b[0])
	}
	if !strings.HasPrefix(string(line), "OK ") {
		conn.Close()
		return nil, fmt.Errorf("vsock handshake: %q", line)
	}
	conn.SetDeadline(time.Time{})
	return conn, nil
}

func (i *fcInstance) Shutdown(ctx context.Context) error {
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", i.apiSock)
		},
	}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, "http://fc/actions", bytes.NewReader([]byte(`{"action_type":"SendCtrlAltDel"}`)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("SendCtrlAltDel returned %d", resp.StatusCode)
	}
	select {
	case <-i.done:
		return nil
	case <-ctx.Done():
		return errors.New("guest did not power off in time")
	}
}

func ReadLogTail(dir, id string, n int) string {
	b, err := os.ReadFile(filepath.Join(dir, id+".log"))
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func init() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}
