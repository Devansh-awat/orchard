package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hackclub/orchard/fc-builder/internal/api"
	"github.com/hackclub/orchard/fc-builder/internal/builds"
	"github.com/hackclub/orchard/fc-builder/internal/cache"
	"github.com/hackclub/orchard/fc-builder/internal/cgroups"
	"github.com/hackclub/orchard/fc-builder/internal/netsetup"
	"github.com/hackclub/orchard/fc-builder/internal/proto"
	"github.com/hackclub/orchard/fc-builder/internal/proxy"
	"github.com/hackclub/orchard/fc-builder/internal/vm"
)

var Version = "dev"

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if n, err := strconv.Atoi(env(key, "")); err == nil {
		return n
	}
	return def
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(env(key, "")) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	return def
}

func mustEnv(key string) string {
	v := env(key, "")
	if v == "" {
		log.Fatalf("%s is required", key)
	}
	return v
}

func resolvConf() (string, []string) {
	b, err := os.ReadFile("/etc/resolv.conf")
	if err != nil {
		return "", nil
	}
	var dns string
	var search []string
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		switch f[0] {
		case "nameserver":
			if dns == "" {
				dns = f[1]
			}
		case "search":
			search = f[1:]
		}
	}
	return dns, search
}

func parseBytes(s string) uint64 {
	s = strings.ToUpper(strings.TrimSpace(s))
	mult := uint64(1)
	for suffix, m := range map[string]uint64{"T": 1 << 40, "G": 1 << 30, "M": 1 << 20} {
		if strings.HasSuffix(s, suffix) {
			s, mult = strings.TrimSuffix(s, suffix), m
			break
		}
	}
	n, _ := strconv.ParseUint(s, 10, 64)
	return n * mult
}

func stageAsset(src, dir string) string {
	dst := filepath.Join(dir, filepath.Base(src))
	if st, err := os.Stat(dst); err == nil {
		if srcSt, err := os.Stat(src); err == nil && st.Size() == srcSt.Size() && !st.ModTime().Before(srcSt.ModTime()) {
			return dst
		}
	}
	in, err := os.ReadFile(src)
	if err != nil {
		log.Fatalf("read asset %s: %v", src, err)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, in, 0o644); err != nil {
		log.Fatalf("stage asset %s: %v", src, err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		log.Fatalf("stage asset %s: %v", src, err)
	}
	return dst
}

func killStaleVMs(stateDir string) {
	entries, _ := os.ReadDir("/proc")
	killed := 0
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		comm, err := os.ReadFile(filepath.Join("/proc", e.Name(), "comm"))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(string(comm))
		if name == "firecracker" || name == "jailer" {
			syscall.Kill(pid, syscall.SIGKILL)
			killed++
		}
	}
	if killed > 0 {
		log.Printf("[fc-builder] killed %d leftover VM processes", killed)
		time.Sleep(2 * time.Second)
	}
	for _, d := range []string{"jail", "vms"} {
		os.RemoveAll(filepath.Join(stateDir, d))
	}
}

func nestCgroups(useCgroups bool, maxVMs int, perVM int64) (*cgroups.Tree, int) {
	if !useCgroups {
		return nil, maxVMs
	}
	self, err := cgroups.Own("/proc/self/cgroup")
	if err != nil {
		log.Fatalf("cgroup: %v", err)
	}
	tree := &cgroups.Tree{Mount: cgroups.Mount, Self: self}
	if err := tree.Nest("cpu", "memory"); err != nil {
		log.Fatalf("cgroup: %v", err)
	}
	limit, ok := tree.MemoryMax()
	if !ok {
		log.Printf("[fc-builder] pod has no memory limit, VMs are only capped individually")
		return tree, maxVMs
	}
	fit := cgroups.FitVMs(maxVMs, limit, perVM, int64(envInt("FC_HOST_RESERVE_MIB", 2048))<<20)
	if fit == 0 {
		log.Fatalf("pod memory limit %d bytes cannot hold a single %d byte VM", limit, perVM)
	}
	if fit < maxVMs {
		log.Printf("[fc-builder] pod memory limit holds %d VMs, not %d; capping", fit, maxVMs)
	}
	return tree, fit
}

func roomCheck(tree *cgroups.Tree, perVM, minFree int64) func() bool {
	var short atomic.Bool
	return func() bool {
		avail, err := cgroups.MemAvailable("/proc/meminfo")
		if err != nil {
			return true
		}
		var pending int64
		if tree != nil {
			pending = tree.Uncommitted()
		}
		room := avail-pending-perVM >= minFree
		if short.Swap(!room) != !room {
			if room {
				log.Printf("[fc-builder] node memory recovered, booting VMs again")
			} else {
				log.Printf("[fc-builder] node memory low (%d MiB available, %d MiB promised to running VMs), refusing new VMs", avail>>20, pending>>20)
			}
		}
		return room
	}
}

func main() {
	log.SetPrefix("")
	stateDir := env("FC_STATE_DIR", "/state")
	assetsDir := env("FC_ASSETS_DIR", "/opt/fc")
	hostID := env("FC_HOST_ID", env("HOSTNAME", "fc-builder"))
	secret := []byte(mustEnv("FC_BUILDER_TOKEN"))
	proxyPort := envInt("FC_PROXY_PORT", 5000)
	maxVMs := envInt("FC_MAX_VMS", 6)
	cacheSize := env("FC_CACHE_IMAGE_SIZE", "50G")

	killStaleVMs(stateDir)
	useCgroups := envBool("FC_USE_JAILER", true) && envBool("FC_JAILER_CGROUPS", true)
	memMiB := envInt("FC_VM_MEM_MIB", 12288)
	memOverhead := envInt("FC_VM_MEM_OVERHEAD_MIB", 1536)
	_, perVM := vm.MemoryLimits(memMiB, memOverhead)
	tree, maxVMs := nestCgroups(useCgroups, maxVMs, perVM)
	cgroupBase := ""
	if tree != nil {
		cgroupBase = tree.VMParent()
	}
	assets := filepath.Join(stateDir, "assets", Version)
	if err := os.MkdirAll(assets, 0o755); err != nil {
		log.Fatal(err)
	}
	kernel := stageAsset(filepath.Join(assetsDir, "vmlinux"), assets)
	rootfs := stageAsset(filepath.Join(assetsDir, "rootfs.ext4"), assets)

	store, err := cache.New(filepath.Join(stateDir, "cache"), cacheSize)
	if err != nil {
		log.Fatal(err)
	}
	px, err := proxy.New(env("FC_UPSTREAM_REGISTRY", "http://harbor-core.harbor.svc.cluster.local"), mustEnv("HARBOR_USERNAME"), mustEnv("HARBOR_PASSWORD"))
	if err != nil {
		log.Fatal(err)
	}
	if err := netsetup.Global(netsetup.Exec, proxyPort); err != nil {
		log.Fatalf("network setup: %v", err)
	}
	dns, search := resolvConf()
	launcher := &vm.FirecrackerLauncher{
		Firecracker: filepath.Join(assetsDir, "firecracker"),
		Jailer:      filepath.Join(assetsDir, "jailer"),
		Kernel:      kernel,
		Rootfs:      rootfs,
		JailBase:    filepath.Join(stateDir, "jail"),
		WorkDir:     filepath.Join(stateDir, "vms"),
		LogDir:      filepath.Join(stateDir, "vm-logs"),
		UseJailer:   envBool("FC_USE_JAILER", true),
		Cgroups:     useCgroups,
		CgroupRoot:  cgroups.Mount,
		CgroupBase:  cgroupBase,
		MemOverhead: memOverhead,
		IOEngine:    env("FC_IO_ENGINE", "Async"),
	}
	cacheBytes := parseBytes(cacheSize)
	manager := vm.NewManager(vm.Config{
		MaxVMs:      maxVMs,
		VCPUs:       envInt("FC_VM_VCPUS", 8),
		MemMiB:      memMiB,
		IdleTimeout: time.Duration(envInt("FC_VM_IDLE_SECONDS", 300)) * time.Second,
		BootTimeout: time.Duration(envInt("FC_VM_BOOT_TIMEOUT_SECONDS", 60)) * time.Second,
		AcquireWait: time.Duration(envInt("FC_ACQUIRE_WAIT_SECONDS", 20)) * time.Second,
		BaseUID:     envInt("FC_BASE_UID", 300000),
		MTU:         netsetup.PodMTU(),
		DNS:         dns,
		Search:      search,
		GCBytes:     cacheBytes * 7 / 10,
	}, launcher, vm.Hooks{
		EnsureCache: func(tenant string) (string, error) {
			path, _, err := store.Ensure(tenant)
			return path, err
		},
		SetupSlot:    func(s netsetup.Slot, uid int) error { return netsetup.SetupTap(netsetup.Exec, s, uid, uid) },
		TeardownSlot: func(s netsetup.Slot) { netsetup.TeardownTap(netsetup.Exec, s) },
		HasRoom:      roomCheck(tree, perVM, int64(envInt("FC_MIN_NODE_FREE_MIB", 32768))<<20),
	})
	runner, err := builds.NewRunner(filepath.Join(stateDir, "builds"), hostID, manager, px)
	if err != nil {
		log.Fatal(err)
	}
	policy := cache.Policy{
		MaxAge:    time.Duration(envInt("BUILDKIT_CACHE_MAX_AGE_DAYS", 14)) * 24 * time.Hour,
		HighPct:   envInt("BUILDKIT_CACHE_HIGH_PCT", 80),
		TargetPct: envInt("BUILDKIT_CACHE_TARGET_PCT", 60),
		MinIdle:   time.Duration(envInt("BUILDKIT_CACHE_IDLE_MINUTES", 60)) * time.Minute,
	}
	status := func() proto.HostStatus {
		u, _ := store.Usage()
		return proto.HostStatus{
			HostID: hostID, Version: Version, MaxVMs: manager.MaxVMs(), VMs: manager.Status(),
			ActiveBuilds: runner.Active(), CacheTenants: store.Tenants(), DiskTotal: u.Total, DiskUsed: u.Used,
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		reap := time.NewTicker(15 * time.Second)
		evict := time.NewTicker(5 * time.Minute)
		defer reap.Stop()
		defer evict.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-reap.C:
				manager.ReapIdle()
			case <-evict.C:
				store.Evict(policy, manager.HasTenant)
				runner.Prune()
			}
		}
	}()

	proxySrv := &http.Server{Addr: ":" + strconv.Itoa(proxyPort), Handler: px, ReadHeaderTimeout: 30 * time.Second}
	apiSrv := &http.Server{
		Addr:              env("FC_LISTEN", ":8080"),
		Handler:           api.New(runner, status, time.Duration(envInt("FC_ACQUIRE_WAIT_SECONDS", 20)+envInt("FC_VM_BOOT_TIMEOUT_SECONDS", 60))*time.Second).Handler(secret),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	for _, s := range []*http.Server{proxySrv, apiSrv} {
		go func() {
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("listen %s: %v", s.Addr, err)
			}
		}()
	}
	log.Printf("[fc-builder] %s %s ready: %d VM slots, api %s, push proxy :%d", hostID, Version, maxVMs, apiSrv.Addr, proxyPort)
	<-ctx.Done()
	log.Printf("[fc-builder] shutting down")
	drain, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("FC_DRAIN_SECONDS", 20))*time.Second)
	runner.Wait(drain)
	cancel()
	apiSrv.Shutdown(context.Background())
	manager.StopAll()
	proxySrv.Shutdown(context.Background())
}
