package netsetup

import (
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const Subnet = "172.16.0.0/16"

var base = netip.MustParseAddr("172.16.0.0")

type Slot struct {
	Index   int
	Tap     string
	HostIP  netip.Addr
	GuestIP netip.Addr
	MAC     string
}

func ForSlot(i int) Slot {
	if i < 0 || i >= 16384 {
		panic(fmt.Sprintf("slot %d out of range", i))
	}
	b := base.As4()
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	n += uint32(i) * 4
	host := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n + 1)})
	guest := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n + 2)})
	return Slot{
		Index:   i,
		Tap:     "fc" + strconv.Itoa(i),
		HostIP:  host,
		GuestIP: guest,
		MAC:     fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", byte(n>>24), byte(n>>16), byte(n>>8), byte(n+2)),
	}
}

func SlotForGuest(ip netip.Addr) (int, bool) {
	if !ip.Is4() {
		return 0, false
	}
	a := ip.As4()
	b := base.As4()
	if a[0] != b[0] || a[1] != b[1] {
		return 0, false
	}
	off := uint32(a[2])<<8 | uint32(a[3])
	if off%4 != 2 {
		return 0, false
	}
	return int(off / 4), true
}

type Runner func(name string, args ...string) error

func Exec(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func Global(run Runner, proxyPort int) error {
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644); err != nil {
		return fmt.Errorf("enable ip_forward: %w", err)
	}
	return globalRules(run, proxyPort)
}

func globalRules(run Runner, proxyPort int) error {
	rules := [][]string{
		{"-t", "nat", "-A", "POSTROUTING", "-s", Subnet, "!", "-d", Subnet, "-j", "MASQUERADE"},
		{"-A", "FORWARD", "-s", Subnet, "-d", Subnet, "-j", "DROP"},
		{"-A", "FORWARD", "-s", Subnet, "-d", "169.254.0.0/16", "-j", "DROP"},
		{"-A", "INPUT", "-s", Subnet, "-p", "tcp", "--dport", strconv.Itoa(proxyPort), "-j", "ACCEPT"},
		{"-A", "INPUT", "-s", Subnet, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-A", "INPUT", "-s", Subnet, "-j", "DROP"},
	}
	for _, r := range rules {
		check := append([]string{}, r...)
		for i, a := range check {
			if a == "-A" {
				check[i] = "-C"
			}
		}
		if run("iptables", check...) == nil {
			continue
		}
		if err := run("iptables", r...); err != nil {
			return err
		}
	}
	return nil
}

func SetupTap(run Runner, s Slot, uid, gid int) error {
	_ = run("ip", "link", "del", s.Tap)
	steps := [][]string{
		{"tuntap", "add", "dev", s.Tap, "mode", "tap", "user", strconv.Itoa(uid), "group", strconv.Itoa(gid)},
		{"addr", "add", s.HostIP.String() + "/30", "dev", s.Tap},
		{"link", "set", s.Tap, "up"},
	}
	for _, args := range steps {
		if err := run("ip", args...); err != nil {
			return err
		}
	}
	return nil
}

func TeardownTap(run Runner, s Slot) {
	_ = run("ip", "link", "del", s.Tap)
}

func PodMTU() int {
	b, err := os.ReadFile("/sys/class/net/eth0/mtu")
	if err != nil {
		return 1400
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n < 576 {
		return 1400
	}
	return n
}
