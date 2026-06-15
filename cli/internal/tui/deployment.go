package tui

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

const refreshEvery = 4 * time.Second

var depTabs = []string{"Overview", "Pods", "Logs", "Env"}

type (
	detailMsg struct {
		d   *Deployment
		err error
	}
	podsMsg struct {
		items []Pod
		err   error
	}
	metricsMsg struct {
		m   MetricsResp
		err error
	}
	logsMsg struct {
		l   logsResp
		err error
	}
	runtimeLogsMsg struct {
		logs string
		err  error
	}
	actionMsg struct {
		text string
		err  error
	}
	tickMsg struct{ id string }
)

func fetchDetail(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var d Deployment
		err := cl.GetJSON("/deployments/"+id, &d)
		if err != nil {
			return detailMsg{nil, err}
		}
		return detailMsg{&d, nil}
	}
}
func fetchPods(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Pod](cl, "/deployments/"+id+"/pods")
		return podsMsg{items, err}
	}
}
func fetchMetrics(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var m MetricsResp
		err := cl.GetJSON("/deployments/"+id+"/metrics", &m)
		return metricsMsg{m, err}
	}
}
func fetchLogs(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var l logsResp
		err := cl.GetJSON("/deployments/"+id+"/logs", &l)
		return logsMsg{l, err}
	}
}

// fetchRuntimeLogs pulls live container logs for a pod via the k8s endpoint.
func fetchRuntimeLogs(cl *api.Client, podName, namespace string) tea.Cmd {
	return func() tea.Msg {
		if podName == "" {
			return runtimeLogsMsg{logs: "(no running pods)"}
		}
		var r struct {
			Logs string `json:"logs"`
		}
		path := "/pods/" + url.PathEscape(podName) + "/logs?tailLines=500"
		if namespace != "" {
			path += "&namespace=" + url.QueryEscape(namespace)
		}
		err := cl.GetJSON(path, &r)
		return runtimeLogsMsg{logs: r.Logs, err: err}
	}
}
func tick(id string) tea.Cmd {
	return tea.Tick(refreshEvery, func(time.Time) tea.Msg { return tickMsg{id} })
}

type deploymentScreen struct {
	cl       *api.Client
	project  Project
	id, name string
	tab      int

	detail  *Deployment
	pods    []Pod
	metrics MetricsResp
	logs    logsResp
	runtime string
	logVP   viewport.Model

	logSource int // 0 = runtime, 1 = build
	podCursor int
	envCursor int
	tabSpans  [][2]int // X ranges of each tab in the border row (Y==1)
	hitPods   hitTable
	loading   bool
	w, h      int
}

var logSources = []string{"Runtime", "Build"}

// firstPodName picks a pod to stream runtime logs from (prefer a Running one).
func (s *deploymentScreen) firstPodName() string {
	for _, p := range s.pods {
		if lc(p.Status) == "running" {
			return p.Name
		}
	}
	if len(s.pods) > 0 {
		return s.pods[0].Name
	}
	return ""
}

func (s *deploymentScreen) namespace() string {
	if s.detail != nil && s.detail.Namespace != "" {
		return s.detail.Namespace
	}
	for _, p := range s.pods {
		if p.Namespace != "" {
			return p.Namespace
		}
	}
	return ""
}

// loadLogs fetches the currently selected log source.
func (s *deploymentScreen) loadLogs() tea.Cmd {
	if s.logSource == 1 {
		return fetchLogs(s.cl, s.id)
	}
	return fetchRuntimeLogs(s.cl, s.firstPodName(), s.namespace())
}

func (s *deploymentScreen) setLogContent() {
	var content string
	if s.logSource == 1 {
		content = s.logs.Logs
		if strings.TrimSpace(content) == "" {
			content = stMuted.Render("(no build logs)")
		}
	} else {
		content = s.runtime
		if strings.TrimSpace(content) == "" {
			content = stMuted.Render("(no runtime logs yet)")
		}
	}
	s.logVP.SetContent(content)
	s.logVP.GotoBottom()
}

func newDeploymentScreen(cl *api.Client, p Project, id, name string) *deploymentScreen {
	return &deploymentScreen{cl: cl, project: p, id: id, name: name, loading: true}
}

func (s *deploymentScreen) title() string { return s.name }

func (s *deploymentScreen) Init() tea.Cmd {
	return tea.Batch(
		fetchDetail(s.cl, s.id),
		fetchPods(s.cl, s.id),
		fetchMetrics(s.cl, s.id),
		fetchLogs(s.cl, s.id),
		tick(s.id),
	)
}

// refreshLogs reloads the active log source if the Logs tab is showing.
func (s *deploymentScreen) refreshLogs() tea.Cmd {
	if s.tab == 2 {
		return s.loadLogs()
	}
	return nil
}

func (s *deploymentScreen) refresh() tea.Cmd {
	return tea.Batch(fetchDetail(s.cl, s.id), fetchPods(s.cl, s.id), fetchMetrics(s.cl, s.id))
}

func (s *deploymentScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.logVP.Width = s.w - 4
		s.logVP.Height = s.h - chromeH - 2
	case tickMsg:
		if msg.id == s.id {
			return s, tea.Batch(s.refresh(), s.refreshLogs(), tick(s.id))
		}
	case detailMsg:
		s.loading = false
		if msg.err == nil {
			s.detail = msg.d
		}
	case podsMsg:
		hadPods := len(s.pods) > 0
		s.pods = msg.items
		if s.podCursor >= len(s.pods) {
			s.podCursor = 0
		}
		// once pods are known we can stream runtime logs
		if !hadPods && len(s.pods) > 0 && s.tab == 2 && s.logSource == 0 {
			return s, s.loadLogs()
		}
	case metricsMsg:
		if msg.err == nil {
			s.metrics = msg.m
		}
	case logsMsg:
		if msg.err == nil {
			s.logs = msg.l
		}
		if s.logSource == 1 {
			s.setLogContent()
		}
	case runtimeLogsMsg:
		if msg.err != nil {
			s.runtime = stRed.Render("✗ " + msg.err.Error())
		} else {
			s.runtime = msg.logs
		}
		if s.logSource == 0 {
			s.setLogContent()
		}
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case envSavedMsg:
		return s, tea.Batch(fetchDetail(s.cl, s.id), flashf("environment updated — redeploying"))
	case tea.MouseMsg:
		// click a tab in the panel border row (Y == 1)
		if msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress && msg.Y == 1 {
			for i, sp := range s.tabSpans {
				if msg.X >= sp[0] && msg.X <= sp[1] {
					if s.tab != i {
						s.tab = i
						return s, s.refreshLogs()
					}
					return s, nil
				}
			}
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.tab == 1 && s.podCursor > 0 {
				s.podCursor--
			} else if s.tab == 3 && s.envCursor > 0 {
				s.envCursor--
			}
		case tea.MouseButtonWheelDown:
			if s.tab == 1 && s.podCursor < len(s.pods)-1 {
				s.podCursor++
			} else if s.tab == 3 && s.detail != nil && s.envCursor < len(s.detail.EnvVars)-1 {
				s.envCursor++
			}
		case tea.MouseButtonLeft:
			if msg.Action == tea.MouseActionPress && s.tab == 1 {
				if idx := s.hitPods.rowAt(msg.X, msg.Y, s.podCursor); idx >= 0 {
					s.podCursor = idx
				}
			}
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "tab", "right":
			s.tab = (s.tab + 1) % len(depTabs)
			return s, s.refreshLogs()
		case "left", "h":
			s.tab = (s.tab - 1 + len(depTabs)) % len(depTabs)
			return s, s.refreshLogs()
		case "1", "2", "3", "4":
			s.tab = int(msg.String()[0] - '1')
			return s, s.refreshLogs()
		case "b":
			if s.tab == 2 {
				s.logSource = 1 - s.logSource
				s.setLogContent()
				return s, s.loadLogs()
			}
		case "r":
			return s, tea.Batch(s.refresh(), s.refreshLogs())
		case "R":
			return s, doAction(s.cl, "POST", "/deployments/"+s.id+"/restart", nil, "restart triggered")
		case "B":
			return s, doAction(s.cl, "POST", "/deployments/"+s.id+"/rebuild", nil, "rebuild triggered")
		case "s":
			return s, push(newScaleScreen(s.cl, s.id, s.curReplicas()))
		case "e":
			if s.tab == 3 && s.detail != nil {
				return s, push(newEnvScreen(s.cl, s.id, s.detail.EnvVars))
			}
		case "up", "k":
			if s.tab == 1 && s.podCursor > 0 {
				s.podCursor--
			} else if s.tab == 3 && s.envCursor > 0 {
				s.envCursor--
			} else if s.tab == 2 {
				s.logVP.LineUp(1)
			}
		case "down", "j":
			if s.tab == 1 && s.podCursor < len(s.pods)-1 {
				s.podCursor++
			} else if s.tab == 3 && s.detail != nil && s.envCursor < len(s.detail.EnvVars)-1 {
				s.envCursor++
			} else if s.tab == 2 {
				s.logVP.LineDown(1)
			}
		}
	}
	if s.tab == 2 {
		var cmd tea.Cmd
		s.logVP, cmd = s.logVP.Update(msg)
		return s, cmd
	}
	return s, nil
}

func (s *deploymentScreen) curReplicas() int {
	if s.detail != nil {
		return s.detail.Replicas
	}
	return 1
}

func (s *deploymentScreen) help() []keyHint {
	if s.tab == 2 {
		return []keyHint{{"←/→", "tabs"}, {"b", "build/runtime"}, {"↑/↓", "scroll"}, {"r", "refresh"}, {"esc", "back"}}
	}
	return []keyHint{{"←/→", "tabs"}, {"s", "scale"}, {"R", "restart"},
		{"B", "rebuild"}, {"e", "edit env"}, {"r", "refresh"}, {"esc", "back"}}
}

func (s *deploymentScreen) View() string {
	if s.loading && s.detail == nil {
		return stMuted.Render("\n  loading deployment…")
	}
	bodyH := s.h - chromeH
	strip := renderTabs(depTabs, s.tab)

	// tab X-spans within the border row (after "╭─┤ " = 4 cells, " · " seps = 3)
	spans := make([][2]int, len(depTabs))
	x := 4
	for i, t := range depTabs {
		spans[i] = [2]int{x, x + len(t) - 1}
		x += len(t) + 3
	}
	s.tabSpans = spans

	switch s.tab {
	case 0:
		return s.viewOverview(bodyH, strip)
	case 1:
		s.hitPods = hitTable{topY: 4, visible: bodyH - 4, count: len(s.pods), minX: 0, maxX: s.w - 1}
		return panelRaw(strip, s.viewPods(bodyH), s.w, bodyH, true)
	case 2:
		title := strip + stMuted.Render("   source: ") + renderTabs(logSources, s.logSource)
		return panelRaw(title, s.logVP.View(), s.w, bodyH, true)
	case 3:
		return panelRaw(strip, s.viewEnv(bodyH), s.w, bodyH, true)
	}
	return ""
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
	leftW := s.w * 3 / 5
	rightW := s.w - leftW

	// left: info
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
	if len(d.Ingresses) > 0 {
		for i, ig := range d.Ingresses {
			k := "URL"
			if i > 0 {
				k = ""
			}
			row(k, stLink.Render("https://"+ig.Host))
		}
	}

	// right: resources — braille area graphs + usage-vs-request bars (btop style)
	cpu := float64(d.TotalCPUUsage)
	mem := float64(d.TotalMemoryUsage)
	cpuReq := float64(d.CPURequestMilli)
	memReq := float64(d.MemoryRequestB)
	gw := rightW - 4
	graphH := (height - 2 - 9) / 2
	if graphH < 2 {
		graphH = 2
	}

	var res strings.Builder
	cpuHdr := stKey.Render("CPU") + "   " + stGreen.Render(fmtCPU(cpu))
	if cpuReq > 0 {
		cpuHdr += stMuted.Render(" / " + fmtCPU(cpuReq))
	}
	res.WriteString(cpuHdr + "\n")
	res.WriteString(brailleGraph(values(s.metrics.Data.CPU), gw, graphH) + "\n")
	if cpuReq > 0 {
		res.WriteString(barMeter(cpu, cpuReq, gw) + "\n")
	}
	res.WriteString("\n")

	memHdr := stKey.Render("Memory") + "  " + stGreen.Render(fmtBytes(mem))
	if memReq > 0 {
		memHdr += stMuted.Render(" / " + fmtBytes(memReq))
	}
	res.WriteString(memHdr + "\n")
	res.WriteString(brailleGraph(values(s.metrics.Data.Memory), gw, graphH) + "\n")
	if memReq > 0 {
		res.WriteString(barMeter(mem, memReq, gw) + "\n")
	}
	res.WriteString("\n" + stMuted.Render(fmt.Sprintf("⟳ live · every %s", refreshEvery)))

	left := panelRaw(strip, info.String(), leftW, height, true)
	right := panel("Resources", res.String(), rightW, height, false)
	return sideBySide(left, right)
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
			stMuted.Render(orDash(p.NodeName)),
			stMuted.Render(age),
		}
	}
	cols := []col{{title: "POD"}, {title: "STATUS"}, {title: "READY"}, {title: "RESTARTS"}, {title: "NODE"}, {title: "AGE"}}
	return renderTable(cols, rows, s.podCursor, s.w-2, height-2)
}

func (s *deploymentScreen) viewEnv(height int) string {
	if s.detail == nil {
		return stMuted.Render("  no data")
	}
	rows := make([][]string, len(s.detail.EnvVars))
	for i, e := range s.detail.EnvVars {
		rows[i] = []string{stKey.Render(e.Key), stMuted.Render(e.Value)}
	}
	return renderTable([]col{{title: "KEY"}, {title: "VALUE"}}, rows, s.envCursor, s.w-2, height-2)
}

// doAction runs a mutating request and reports the result.
func doAction(cl *api.Client, method, path string, body any, okText string) tea.Cmd {
	return func() tea.Msg {
		err := cl.Send(method, path, body, nil)
		return actionMsg{okText, err}
	}
}

func values(pts []MetricPoint) []float64 {
	out := make([]float64, len(pts))
	for i, p := range pts {
		out[i] = p.Value
	}
	return out
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}
