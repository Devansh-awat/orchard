package netsetup

import (
	"net/netip"
	"strings"
	"testing"
)

func TestSlotAddressing(t *testing.T) {
	cases := []struct {
		slot        int
		host, guest string
	}{
		{0, "172.16.0.1", "172.16.0.2"},
		{1, "172.16.0.5", "172.16.0.6"},
		{63, "172.16.0.253", "172.16.0.254"},
		{64, "172.16.1.1", "172.16.1.2"},
		{16383, "172.16.255.253", "172.16.255.254"},
	}
	for _, c := range cases {
		s := ForSlot(c.slot)
		if s.HostIP.String() != c.host || s.GuestIP.String() != c.guest {
			t.Errorf("slot %d: got %s/%s", c.slot, s.HostIP, s.GuestIP)
		}
		got, ok := SlotForGuest(s.GuestIP)
		if !ok || got != c.slot {
			t.Errorf("slot %d reverse: got %d %v", c.slot, got, ok)
		}
	}
}

func TestSlotForGuestRejectsNonGuests(t *testing.T) {
	for _, ip := range []string{"172.16.0.1", "172.16.0.3", "10.0.0.2", "172.17.0.2"} {
		if _, ok := SlotForGuest(netip.MustParseAddr(ip)); ok {
			t.Errorf("%s accepted as guest", ip)
		}
	}
}

func TestUniqueMACs(t *testing.T) {
	seen := map[string]int{}
	for i := 0; i < 512; i++ {
		m := ForSlot(i).MAC
		if j, dup := seen[m]; dup {
			t.Fatalf("slots %d and %d share %s", i, j, m)
		}
		seen[m] = i
	}
}

func TestGlobalSkipsExistingRules(t *testing.T) {
	var calls []string
	run := func(name string, args ...string) error {
		calls = append(calls, strings.Join(args, " "))
		return nil
	}
	if err := globalRules(run, 5000); err != nil {
		t.Fatal(err)
	}
	for _, c := range calls {
		if strings.Contains(c, "-A ") {
			t.Fatalf("appended despite existing rule: %s", c)
		}
	}
}
