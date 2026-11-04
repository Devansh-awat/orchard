package tui

import (
	"context"
	"fmt"
	"io"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/termsession"
)

// The Overview tab is one btop-style board: info + resource graphs up top, the
// pod table and a live log viewport below.

func (s *deploymentScreen) overviewLeftW() int {
	w := s.w * 2 / 5
	if w < 30 {
		w = min(30, s.w-10)
	}
	return max(w, 4)
}

func (s *deploymentScreen) overviewInfoH() int {
	h := (s.h - chromeH) / 2
	if h > 12 {
		h = 12
	}
	return max(h, 5)
}

func (s *deploymentScreen) overviewKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	switch msg.String() {
	case "f":
		s.follow = !s.follow
		if s.follow {
			s.logVP.GotoBottom()
			return s.loadLogs(), true
		}
		return flashf("follow off"), true
	case "b":
		s.logSource = 1 - s.logSource
		s.setLogContent()
		return s.loadLogs(), true
	case "s":
		return s.startShell(), true
	case "S":
		return push(newScaleScreen(s.cl, s.id, s.curReplicas())), true
	case "+", "=":
		return doAction(s.cl, "POST", "/deployments/"+s.id+"/scale",
			map[string]any{"replicas": s.curReplicas() + 1}, fmt.Sprintf("scaling to %d", s.curReplicas()+1)), true
	case "-":
		if n := s.curReplicas() - 1; n >= 0 {
			return doAction(s.cl, "POST", "/deployments/"+s.id+"/scale",
				map[string]any{"replicas": n}, fmt.Sprintf("scaling to %d", n)), true
		}
		return nil, true
	case "R":
		return doAction(s.cl, "POST", "/deployments/"+s.id+"/restart", nil, "restart triggered"), true
	case "B":
		return doAction(s.cl, "POST", "/deployments/"+s.id+"/rebuild", nil, "rebuild triggered"), true
	case "x":
		s.confirm.Show(fmt.Sprintf("Permanently delete deployment %q and its Kubernetes resources?", s.name),
			deleteDeployment(s.cl, s.id, s.name))
		return nil, true
	case "up", "k":
		if s.podCursor > 0 {
			s.podCursor--
		}
		return nil, true
	case "down", "j":
		if s.podCursor < len(s.pods)-1 {
			s.podCursor++
		}
		return nil, true
	}
	return nil, false
}

func (s *deploymentScreen) viewOverview(height int, strip string) string {
	d := s.detail
	if d == nil {
		return stMuted.Render("  no data")
	}
	st := d.Status
	if d.BuildStatus == "building" {
		st = "building"
		if d.BuildStep != "" {
			st = "building: " + d.BuildStep
		}
	}
	leftW := s.overviewLeftW()
	rightW := s.w - leftW
	infoH := s.overviewInfoH()
	botH := height - infoH

	// top-left: info
	var info strings.Builder
	row := func(k, v string) {
		info.WriteString(stKey.Render(pad(k, 11)) + " " + v + "\n")
	}
	row("Status", badge(st))
	row("Replicas", fmt.Sprintf("%d / %d", d.AvailableReplicas, d.Replicas))
	row("Image", stMuted.Render(d.Image))
	if d.GithubRepo != "" {
		row("Source", stMuted.Render(fmt.Sprintf("%s @ %s", d.GithubRepo, orDash(d.GithubBranch))))
	}
	for i, ig := range d.Ingresses {
		k := "URL"
		if i > 0 {
			k = ""
		}
		row(k, stLink.Render(ingressURL(ig.URL, ig.Host)))
	}

	// top-right resources: braille area graphs + usage-vs-request bars
	cpu := float64(d.TotalCPUUsage)
	mem := float64(d.TotalMemoryUsage)
	cpuReq, hasCPUReq := f64p(d.CPURequestMilli)
	memReq, hasMemReq := f64p(d.MemoryRequestB)
	gw := rightW - 4
	graphH := (infoH - 2 - 4) / 2
	if graphH < 1 {
		graphH = 1
	}

	var res strings.Builder
	cpuHdr := stKey.Render("CPU") + "   " + stGreen.Render(fmtCPU(cpu))
	if hasCPUReq && cpuReq > 0 {
		cpuHdr += stMuted.Render(" / " + fmtCPU(cpuReq))
	}
	res.WriteString(cpuHdr + "\n")
	res.WriteString(brailleGraph(values(s.metrics.Data.CPU), gw, graphH) + "\n")
	memHdr := stKey.Render("Memory") + "  " + stGreen.Render(fmtBytes(mem))
	if hasMemReq && memReq > 0 {
		memHdr += stMuted.Render(" / " + fmtBytes(memReq))
	}
	res.WriteString(memHdr + "\n")
	res.WriteString(brailleGraph(values(s.metrics.Data.Memory), gw, graphH) + "\n")
	mode := "○ polling"
	if s.sseLive {
		mode = "● live"
	}
	res.WriteString(stMuted.Render(fmt.Sprintf("⟳ %s · every %s", mode, s.tickEvery())))

	// bottom-left: pods
	podBody := s.viewPods(botH)
	s.hitPods = hitTable{topY: 1 + infoH + 3, visible: botH - 4, count: len(s.pods), minX: 0, maxX: leftW - 1}

	// bottom-right: logs
	src := renderTabs(logSources, s.logSource)
	followTag := stMuted.Render("follow off")
	if s.follow {
		followTag = stGreen.Render("follow")
	}
	logTitle := stTabSel.Render("Logs") + stMuted.Render(" · ") + src + stMuted.Render(" · ") + followTag

	top := lipgloss.JoinHorizontal(lipgloss.Top,
		panelRaw(strip, info.String(), leftW, infoH, true),
		panel("Resources", res.String(), rightW, infoH, false))
	bottom := lipgloss.JoinHorizontal(lipgloss.Top,
		panel(fmt.Sprintf("Pods (%d)", len(s.pods)), podBody, leftW, botH, false),
		panelRaw(logTitle, s.logVP.View(), rightW, botH, false))
	return top + "\n" + bottom
}

func (s *deploymentScreen) viewPods(height int) string {
	rows := make([][]string, len(s.pods))
	for i, p := range s.pods {
		age := p.Age
		if age == "" {
			age = p.CreatedAt
		}
		rows[i] = []string{
			p.Name,
			statusDot(p.Status),
			orDash(p.Ready),
			fmt.Sprintf("%d", p.RestartCount),
			stMuted.Render(age),
		}
	}
	cols := []col{{title: "POD"}, {title: "STATUS"}, {title: "READY"}, {title: "RESTARTS"}, {title: "AGE"}}
	return renderTable(cols, rows, s.podCursor, s.overviewLeftW()-2, height-2)
}

// wsShell adapts the termsession websocket pump to bubbletea's ExecCommand,
// so the TUI can hand the real terminal to a remote shell and resume after.
type wsShell struct {
	cl        *api.Client
	pod       string
	namespace string
	stdin     io.Reader
	stdout    io.Writer
}

func (c *wsShell) SetStdin(r io.Reader)  { c.stdin = r }
func (c *wsShell) SetStdout(w io.Writer) { c.stdout = w }
func (c *wsShell) SetStderr(io.Writer)   {}

func (c *wsShell) Run() error {
	ctx := context.Background()
	conn, err := c.cl.DialExec(ctx, c.pod, c.namespace, "")
	if err != nil {
		return err
	}
	return termsession.Run(ctx, conn, c.stdin, c.stdout)
}

// startShell opens the terminal directly for a single pod, or arms the pod
// picker when there is a choice.
func (s *deploymentScreen) startShell() tea.Cmd {
	if s.execDenied {
		return flashf("shell needs an API token with the 'exec' scope")
	}
	switch len(s.pods) {
	case 0:
		return errFlash(errInvalid("no pods to shell into"))
	case 1:
		return s.openShell(s.pods[0].Name)
	}
	s.shellPicking = true
	s.shellPick = s.podCursor
	return nil
}

func (s *deploymentScreen) openShell(pod string) tea.Cmd {
	return tea.Exec(&wsShell{cl: s.cl, pod: pod, namespace: s.namespace()},
		func(err error) tea.Msg { return shellDoneMsg{err} })
}

// handleShellDone degrades gracefully when the token lacks the exec scope:
// a 403 hides the shell hint for the rest of the session.
func (s *deploymentScreen) handleShellDone(err error) tea.Cmd {
	if err == nil {
		return flashf("shell session ended")
	}
	if is403(err) {
		s.execDenied = true
		return errFlash(errInvalid("shell denied: this token lacks the 'exec' scope"))
	}
	return errFlash(err)
}

func (s *deploymentScreen) updateShellPicker(msg tea.Msg) (bool, tea.Cmd) {
	if _, isMouse := msg.(tea.MouseMsg); isMouse {
		return true, nil
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return false, nil
	}
	switch k.String() {
	case "up", "k":
		if s.shellPick > 0 {
			s.shellPick--
		}
	case "down", "j":
		if s.shellPick < len(s.pods)-1 {
			s.shellPick++
		}
	case "enter":
		pick := s.shellPick
		s.shellPicking = false
		if pick < len(s.pods) {
			return true, s.openShell(s.pods[pick].Name)
		}
	case "esc", "q":
		s.shellPicking = false
	}
	return true, nil
}

// shellPickerOverlay splices the pod picker box over the view, confirm-style.
func (s *deploymentScreen) shellPickerOverlay(base string) string {
	if !s.shellPicking {
		return base
	}
	var b strings.Builder
	b.WriteString(stTitle.Render("Open shell in pod") + "\n\n")
	for i, p := range s.pods {
		line := "  " + p.Name
		if i == s.shellPick {
			line = stSelBar.Render("▌") + stSelected.Render(" "+p.Name+" ")
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n" + stMuted.Render("enter open · esc cancel"))
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colAccent)).
		Padding(0, 2).
		Render(b.String())

	boxLines := strings.Split(box, "\n")
	lines := strings.Split(base, "\n")
	h := s.h - chromeH
	for len(lines) < h {
		lines = append(lines, "")
	}
	top := (len(lines) - len(boxLines)) / 2
	if top < 0 {
		top = 0
	}
	for i, bl := range boxLines {
		if top+i >= len(lines) {
			break
		}
		lines[top+i] = lipgloss.PlaceHorizontal(s.w, lipgloss.Center, bl)
	}
	return strings.Join(lines, "\n")
}

// ingressURL prefers the URL the API computed: a self-hosted instance may serve
// on ports other than 80 and 443, which the hostname alone does not say.
func ingressURL(url, host string) string {
	if url != "" {
		return url
	}
	if host == "" {
		return ""
	}
	return "https://" + host
}
