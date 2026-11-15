package commands

import (
	"slices"
	"strings"
	"testing"
)

func ruleIndex(rules [][]string, want string) int {
	return slices.IndexFunc(rules, func(rule []string) bool { return strings.Join(rule, " ") == want })
}

func TestUfwRulesCloseNodeExporterAndFlannelAfterTheClusterAllows(t *testing.T) {
	for _, tunnel := range []bool{false, true} {
		rules := ufwRules([]string{"192.168.1.0/24", tailscaleCIDR}, "80", "443", 30000, 30100, tunnel)
		pods := ruleIndex(rules, "allow from 10.42.0.0/16 to any comment k3s pods")
		services := ruleIndex(rules, "allow from 10.43.0.0/16 to any comment k3s services")
		metrics := ruleIndex(rules, "deny 9100/tcp comment node-exporter, cluster only")
		vxlan := ruleIndex(rules, "deny 8472/udp comment flannel vxlan, single node")
		if pods < 0 || services < 0 || metrics < 0 || vxlan < 0 {
			t.Fatalf("tunnel=%v: missing a rule in %v", tunnel, rules)
		}
		if metrics < pods || metrics < services {
			t.Fatalf("tunnel=%v: ufw stops at the first match, so the pod networks have to come before the deny: %v", tunnel, rules)
		}
		if got := ruleIndex(rules, "allow 80/tcp comment orchard http") >= 0; got == tunnel {
			t.Fatalf("tunnel=%v: http allowed=%v", tunnel, got)
		}
	}
}

func TestFirewalldRulesDropNodeExporterAndFlannelOutsideTheTrustedZone(t *testing.T) {
	rules := firewalldRules([]string{tailscaleCIDR}, "80", "443", 30000, 30100, true)
	for _, want := range []string{
		"--permanent --zone=trusted --add-source=10.42.0.0/16",
		"--permanent --zone=trusted --add-source=10.43.0.0/16",
		"--permanent --add-rich-rule=rule port port=9100 protocol=tcp drop",
		"--permanent --add-rich-rule=rule port port=8472 protocol=udp drop",
	} {
		if ruleIndex(rules, want) < 0 {
			t.Fatalf("missing %q in %v", want, rules)
		}
	}
	if last := strings.Join(rules[len(rules)-1], " "); last != "--reload" {
		t.Fatalf("permanent rules need a reload last, got %q", last)
	}
	if ruleIndex(rules, "--permanent --add-port=80/tcp") >= 0 {
		t.Fatal("tunnel mode opens no http port")
	}
}
