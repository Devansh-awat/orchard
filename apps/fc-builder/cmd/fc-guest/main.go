//go:build linux

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/guest"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
)

var Version = "dev"

const (
	cacheMount   = "/cache"
	buildkitAddr = "unix:///run/buildkit/buildkitd.sock"
	registryHost = "fc-registry:5000"
)

func cmdline() map[string]string {
	out := map[string]string{}
	b, _ := os.ReadFile("/proc/cmdline")
	for _, kv := range strings.Fields(string(b)) {
		if k, v, ok := strings.Cut(kv, "="); ok {
			out[k] = v
		}
	}
	return out
}

func buildkitConfig(gcBytes uint64) string {
	if gcBytes == 0 {
		gcBytes = 30 << 30
	}
	return fmt.Sprintf(`[worker.oci]
  enabled = true
  gc = true
  [[worker.oci.gcpolicy]]
    keepBytes = %d
    filters = ["type==source.local", "type==exec.cachemount", "type==source.git.checkout"]
  [[worker.oci.gcpolicy]]
    all = true
    keepBytes = %d
[worker.containerd]
  enabled = false
[registry."%s"]
  http = true
  insecure = true
`, gcBytes/10, gcBytes, registryHost)
}

func main() {
	log.SetPrefix("[fc-guest] ")
	log.SetFlags(log.Lmicroseconds)
	args := cmdline()
	port := uint64(proto.GuestPort)
	if v, err := strconv.ParseUint(args["fc_port"], 10, 32); err == nil {
		port = v
	}
	gc, _ := strconv.ParseUint(args["fc_gc"], 10, 64)
	if err := os.MkdirAll("/run/buildkit", 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile("/run/buildkitd.toml", []byte(buildkitConfig(gc)), 0o644); err != nil {
		log.Fatal(err)
	}
	for _, d := range []string{"buildkit", "git", "work", "meta"} {
		os.MkdirAll(cacheMount+"/"+d, 0o700)
	}
	os.RemoveAll(cacheMount + "/work")
	os.RemoveAll(cacheMount + "/meta")
	os.MkdirAll(cacheMount+"/work", 0o700)
	os.MkdirAll(cacheMount+"/meta", 0o700)

	ctx, cancel := context.WithCancel(context.Background())
	bk := &guest.Buildkitd{
		Addr: buildkitAddr,
		Args: []string{"--addr", buildkitAddr, "--root", cacheMount + "/buildkit", "--config", "/run/buildkitd.toml"},
	}
	go bk.Supervise(ctx)

	fd, err := guest.ListenVsock(uint32(port))
	if err != nil {
		log.Fatalf("vsock listen: %v", err)
	}
	srv := &guest.Server{
		Runner: &guest.Runner{
			CacheDir: cacheMount, BuildkitAddr: buildkitAddr,
			Workspace: "/workspace", MetaPath: "/orchard-build", Isolate: true,
		},
		Ready: bk.Ready,
	}
	go func() {
		if err := srv.Serve(ctx, fd); err != nil && ctx.Err() == nil {
			log.Printf("serve: %v", err)
		}
	}()
	log.Printf("fc-guest %s listening on vsock port %d", Version, port)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")
	cancel()
	time.Sleep(200 * time.Millisecond)
	bk.Stop(15 * time.Second)
	guest.PowerOff(cacheMount)
}
