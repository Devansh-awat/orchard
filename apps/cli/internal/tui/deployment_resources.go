package tui

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// Resources tab: CPU/memory request editor plus the member quota budget
// (GET /organizations/:orgId/quota/me), rendered with the shared bar helpers.

func (s *deploymentScreen) resourcesKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	switch msg.String() {
	case "e", "enter":
		if s.detail != nil {
			return push(newResourcesForm(s.cl, s.id, s.detail)), true
		}
		return nil, true
	}
	return nil, false
}

func (s *deploymentScreen) viewResources(height int) string {
	d := s.detail
	if d == nil {
		return stMuted.Render("  no data")
	}
	gw := s.w - 8
	graphH := (height - 16) / 2
	if graphH < 1 {
		graphH = 1
	}

	var b strings.Builder
	line := func(k, v string) {
		b.WriteString(" " + stKey.Render(pad(k, 16)) + " " + v + "\n")
	}

	cpuReq, hasCPUReq := f64p(d.CPURequestMilli)
	memReq, hasMemReq := f64p(d.MemoryRequestB)
	cpuLbl, memLbl := stMuted.Render("(org default)"), stMuted.Render("(org default)")
	if hasCPUReq && cpuReq > 0 {
		cpuLbl = fmtCPU(cpuReq)
	}
	if hasMemReq && memReq > 0 {
		memLbl = fmtBytes(memReq)
	}
	line("CPU request", cpuLbl)
	line("Memory request", memLbl)
	b.WriteString("\n")

	cpu, mem := float64(d.TotalCPUUsage), float64(d.TotalMemoryUsage)
	b.WriteString(" " + stKey.Render("CPU usage") + "  " + stGreen.Render(fmtCPU(cpu)) + "\n")
	b.WriteString(indent(brailleGraph(values(s.metrics.Data.CPU), gw, graphH)) + "\n")
	b.WriteString(" " + stKey.Render("Memory usage") + "  " + stGreen.Render(fmtBytes(mem)) + "\n")
	b.WriteString(indent(brailleGraph(values(s.metrics.Data.Memory), gw, graphH)) + "\n\n")

	b.WriteString(" " + stTitle.Render("Your quota budget") + "\n")
	switch {
	case s.quotaErr != nil:
		b.WriteString(" " + stRed.Render("✗ "+s.quotaErr.Error()) + "\n")
	case s.quota == nil:
		b.WriteString(" " + stMuted.Render("loading…") + "\n")
	default:
		q := s.quota
		if used, ok := f64p(q.Usage.CPUMilli); ok {
			if allow, ok := f64p(q.Allowance.CPUMilli); ok && allow > 0 {
				line("CPU", barMeter(used, allow, gw-18)+stMuted.Render("  "+fmtCPU(used)+" / "+fmtCPU(allow)))
			} else {
				line("CPU", fmtCPU(used)+stMuted.Render(" used · allowance unlimited"))
			}
		}
		if used, ok := f64p(q.Usage.MemoryBytes); ok {
			if allow, ok := f64p(q.Allowance.MemoryBytes); ok && allow > 0 {
				line("Memory", barMeter(used, allow, gw-18)+stMuted.Render("  "+fmtBytes(used)+" / "+fmtBytes(allow)))
			} else {
				line("Memory", fmtBytes(used)+stMuted.Render(" used · allowance unlimited"))
			}
		}
		if cpuHead, ok := f64p(q.EffectiveLimit.CPUMilli); ok {
			memHead, _ := f64p(q.EffectiveLimit.MemoryBytes)
			line("Headroom", stGreen.Render(fmtCPU(cpuHead))+stMuted.Render(" cpu · ")+stGreen.Render(fmtBytes(memHead))+stMuted.Render(" memory"))
		}
	}
	return b.String()
}

func indent(s string) string {
	return " " + strings.ReplaceAll(s, "\n", "\n ")
}

// newResourcesForm PATCHes /deployments/:id/resources. An omitted field there
// means "clear to the org default", so both fields are always sent (mirrors
// cmd/deploy_config.go's read-modify-write).
func newResourcesForm(cl *api.Client, depID string, d *DepDetail) *formScreen {
	cpuF := fld("cpu", "CPU request (millicores, empty = org default)", "500", false)
	if v, ok := f64p(d.CPURequestMilli); ok && v > 0 {
		cpuF.ti.SetValue(strconv.Itoa(int(v)))
	}
	memF := fld("memory", "Memory request (e.g. 512Mi, empty = org default)", "512Mi", false)
	if v, ok := f64p(d.MemoryRequestB); ok && v > 0 {
		memF.ti.SetValue(strconv.FormatInt(int64(v), 10))
	}
	return newForm("Edit resource requests",
		"Pods roll to pick up the new requests.",
		[]*field{cpuF, memF},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"cpuRequestMilli": nil, "memoryRequestBytes": nil}
				if v["cpu"] != "" {
					n, err := strconv.Atoi(v["cpu"])
					if err != nil || n <= 0 {
						return formResult{err: errInvalid("cpu must be a positive number of millicores")}
					}
					body["cpuRequestMilli"] = n
				}
				if v["memory"] != "" {
					b, err := parseMemBytes(v["memory"])
					if err != nil {
						return formResult{err: err}
					}
					body["memoryRequestBytes"] = b
				}
				err := cl.Send(ctxBG(), "PATCH", "/deployments/"+url.PathEscape(depID)+"/resources", body, nil)
				return formResult{ok: actionMsg{text: "resources updated — pods rolling"}, err: err}
			}
		})
}
