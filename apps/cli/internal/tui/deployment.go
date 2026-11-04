package tui

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/hackclub/orchard/cli/internal/api"
)

const (
	refreshEvery    = 4 * time.Second  // fast poll while the event stream is down
	refreshEverySSE = 30 * time.Second // slow safety net while SSE delivers
)

// Tab layout mirrors the frontend deployment page.
const (
	tabOverview = iota
	tabEnv
	tabDeploys
	tabNetwork
	tabStorage
	tabResources
	tabAdvanced
)

var depTabs = []string{"Overview", "Env", "Deploys", "Network", "Storage", "Resources", "Advanced"}

type (
	detailMsg struct {
		d   *DepDetail
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
	tickMsg struct {
		id  string
		gen int
	}
	deleteDoneMsg struct {
		name string
		err  error
	}
)

func fetchDetail(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var d DepDetail
		err := cl.GetJSON(context.Background(), "/deployments/"+id, &d)
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
		err := cl.GetJSON(context.Background(), "/deployments/"+id+"/metrics", &m)
		return metricsMsg{m, err}
	}
}
func fetchLogs(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var l logsResp
		err := cl.GetJSON(context.Background(), "/deployments/"+id+"/logs", &l)
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
		err := cl.GetJSON(context.Background(), path, &r)
		return runtimeLogsMsg{logs: r.Logs, err: err}
	}
}

// deleteDeployment removes the deployment and its Kubernetes resources.
func deleteDeployment(cl *api.Client, id, name string) tea.Cmd {
	return func() tea.Msg {
		err := cl.Send(context.Background(), "DELETE", "/deployments/"+id, nil, nil)
		return deleteDoneMsg{name, err}
	}
}

type deploymentScreen struct {
	cl       *api.Client
	project  Project
	id, name string
	tab      int

	detail  *DepDetail
	pods    []Pod
	metrics MetricsResp
	logs    logsResp
	runtime string
	logVP   viewport.Model

	logSource int  // 0 = runtime, 1 = build
	follow    bool // auto-refetch + stick logs to the bottom
	podCursor int
	envCursor int

	// Deploys tab
	deployPane int // 0 = history, 1 = webhook tokens
	histCursor int
	tokens     []WebhookToken
	tokensErr  error
	tokLoaded  bool
	tokCursor  int
	newToken   string // freshly minted webhook secret (shown once)

	// Network tab
	netPane   int // 0 = services, 1 = domains
	svcCursor int
	domCursor int
	ts        TailscaleInfo
	tsErr     error
	tsLoaded  bool

	// Storage tab
	volCursor int

	// Resources tab
	quota       *QuotaMe
	quotaErr    error
	quotaLoaded bool

	// Advanced tab
	audit       []AuditEntry
	auditErr    error
	auditCursor int

	execDenied   bool // token lacks the exec scope: hide the shell hint
	shellPicking bool // pod picker for the shell is up
	shellPick    int  // pod picker cursor

	tabSpans [][2]int // X ranges of each tab in the border row (Y==1)
	hitPods  hitTable
	loading  bool
	sseLive  bool // org event stream up → stretch the poll interval
	tickGen  int  // invalidates in-flight ticks when the cadence changes
	confirm  confirmModel
	w, h     int
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

func (s *deploymentScreen) orgID() string { return s.project.OrganizationID }

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
	if s.follow {
		s.logVP.GotoBottom()
	}
}

func newDeploymentScreen(cl *api.Client, p Project, id, name string) *deploymentScreen {
	return &deploymentScreen{cl: cl, project: p, id: id, name: name, loading: true, follow: true}
}

func (s *deploymentScreen) title() string { return s.name }

func (s *deploymentScreen) Init() tea.Cmd {
	return tea.Batch(
		fetchDetail(s.cl, s.id),
		fetchPods(s.cl, s.id),
		fetchMetrics(s.cl, s.id),
		fetchLogs(s.cl, s.id),
		s.tick(),
	)
}

// tickEvery adapts the poll cadence to the event stream: 4s of hard polling
// when SSE is down, a 30s safety net when events cover us.
func (s *deploymentScreen) tickEvery() time.Duration {
	if s.sseLive {
		return refreshEverySSE
	}
	return refreshEvery
}

func (s *deploymentScreen) tick() tea.Cmd {
	gen := s.tickGen
	return tea.Tick(s.tickEvery(), func(time.Time) tea.Msg { return tickMsg{s.id, gen} })
}

// OnOrgEvent refreshes the panes a bus event invalidates, instead of waiting
// out the tick. deployment.metrics feeds the graphs directly when the payload
// parses; anything unparseable falls back to a refetch.
func (s *deploymentScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	if ev.ID != s.id {
		return nil
	}
	switch ev.Type {
	case "deployment.changed", "build.changed":
		cmds := []tea.Cmd{s.refresh(), s.refreshLogs()}
		if s.tab == tabAdvanced {
			cmds = append(cmds, fetchDepAudit(s.cl, s.id))
		}
		return tea.Batch(cmds...)
	case "pod.changed":
		return tea.Batch(fetchPods(s.cl, s.id), s.refreshLogs())
	case "deployment.metrics":
		if cpu, mem, ok := parseMetricsPayload(ev.Payload); ok {
			s.pushMetricPoint(cpu, mem)
			return nil
		}
		return fetchMetrics(s.cl, s.id)
	}
	return nil
}

// pushMetricPoint appends a live sample from the event bus to the graphs and
// updates the headline usage numbers.
func (s *deploymentScreen) pushMetricPoint(cpu, mem float64) {
	ts := float64(time.Now().Unix())
	const keep = 240
	s.metrics.Data.CPU = append(s.metrics.Data.CPU, MetricPoint{Timestamp: ts, Value: cpu})
	s.metrics.Data.Memory = append(s.metrics.Data.Memory, MetricPoint{Timestamp: ts, Value: mem})
	if n := len(s.metrics.Data.CPU); n > keep {
		s.metrics.Data.CPU = s.metrics.Data.CPU[n-keep:]
	}
	if n := len(s.metrics.Data.Memory); n > keep {
		s.metrics.Data.Memory = s.metrics.Data.Memory[n-keep:]
	}
	if s.detail != nil {
		s.detail.TotalCPUUsage = flexNum(cpu)
		s.detail.TotalMemoryUsage = flexNum(mem)
	}
}

// refreshLogs reloads the active log source when the Overview logs pane is
// visible and following.
func (s *deploymentScreen) refreshLogs() tea.Cmd {
	if s.tab == tabOverview && s.follow {
		return s.loadLogs()
	}
	return nil
}

func (s *deploymentScreen) refresh() tea.Cmd {
	return tea.Batch(fetchDetail(s.cl, s.id), fetchPods(s.cl, s.id), fetchMetrics(s.cl, s.id))
}

// tabDataCmd (re)loads the lazily fetched data behind the active tab.
func (s *deploymentScreen) tabDataCmd() tea.Cmd {
	switch s.tab {
	case tabOverview:
		return s.loadLogs()
	case tabDeploys:
		return fetchWebhookTokens(s.cl, s.id)
	case tabNetwork:
		return fetchTailscale(s.cl, s.id)
	case tabResources:
		return tea.Batch(fetchQuotaMe(s.cl, s.orgID()), fetchMetrics(s.cl, s.id))
	case tabAdvanced:
		return fetchDepAudit(s.cl, s.id)
	}
	return nil
}

// enterTab fires the first-visit fetches for the tab that just became active.
func (s *deploymentScreen) enterTab() tea.Cmd {
	switch s.tab {
	case tabOverview:
		return s.loadLogs()
	case tabDeploys:
		if !s.tokLoaded {
			return fetchWebhookTokens(s.cl, s.id)
		}
	case tabNetwork:
		if !s.tsLoaded {
			return fetchTailscale(s.cl, s.id)
		}
	case tabResources:
		if !s.quotaLoaded {
			return tea.Batch(fetchQuotaMe(s.cl, s.orgID()), fetchMetrics(s.cl, s.id))
		}
	case tabAdvanced:
		return fetchDepAudit(s.cl, s.id)
	}
	return nil
}

func (s *deploymentScreen) setTab(i int) tea.Cmd {
	i = (i + len(depTabs)) % len(depTabs)
	if s.tab == i {
		return nil
	}
	s.tab = i
	return s.enterTab()
}

func (s *deploymentScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	if s.shellPicking {
		if handled, cmd := s.updateShellPicker(msg); handled {
			return s, cmd
		}
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.sizeLogVP()
	case tickMsg:
		if msg.id == s.id && msg.gen == s.tickGen {
			return s, tea.Batch(s.refresh(), s.refreshLogs(), s.tick())
		}
	case sseStatusMsg:
		if s.sseLive != msg.connected {
			s.sseLive = msg.connected
			s.tickGen++ // orphan the in-flight tick, restart at the new cadence
			return s, s.tick()
		}
	case deleteDoneMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, finishForm(createdMsg{"deleted deployment " + msg.name})
	case detailMsg:
		s.loading = false
		if msg.err == nil {
			s.detail = msg.d
			s.clampCursors()
		}
	case podsMsg:
		hadPods := len(s.pods) > 0
		s.pods = msg.items
		if s.podCursor >= len(s.pods) {
			s.podCursor = 0
		}
		// once pods are known we can stream runtime logs
		if !hadPods && len(s.pods) > 0 && s.tab == tabOverview && s.logSource == 0 {
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
	case tokensMsg:
		s.tokLoaded = true
		s.tokens, s.tokensErr = msg.items, msg.err
		if s.tokCursor >= len(s.tokens) {
			s.tokCursor = 0
		}
	case tokenCreatedMsg:
		s.newToken = msg.token
		return s, tea.Batch(fetchWebhookTokens(s.cl, s.id),
			flashf("webhook token created, the secret is shown once"))
	case tailscaleMsg:
		s.tsLoaded = true
		s.ts, s.tsErr = msg.info, msg.err
	case quotaMsg:
		s.quotaLoaded = true
		if msg.err != nil {
			s.quotaErr = msg.err
		} else {
			q := msg.q
			s.quota, s.quotaErr = &q, nil
		}
	case depAuditMsg:
		s.audit, s.auditErr = msg.entries, msg.err
		if s.auditCursor >= len(s.audit) {
			s.auditCursor = 0
		}
	case shellDoneMsg:
		return s, s.handleShellDone(msg.err)
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(), s.tabDataCmd(), flashf("%s", msg.text))
	case envSavedMsg:
		return s, tea.Batch(fetchDetail(s.cl, s.id), flashf("environment updated, redeploying"))
	case tea.MouseMsg:
		return s, s.handleMouse(msg)
	case tea.KeyMsg:
		if cmd, handled := s.handleGlobalKey(msg); handled {
			return s, cmd
		}
		if cmd, handled := s.handleTabKey(msg); handled {
			return s, cmd
		}
	}
	if s.tab == tabOverview {
		var cmd tea.Cmd
		s.logVP, cmd = s.logVP.Update(msg)
		return s, cmd
	}
	return s, nil
}

// clampCursors keeps every per-tab cursor inside the freshly fetched lists.
func (s *deploymentScreen) clampCursors() {
	d := s.detail
	if d == nil {
		return
	}
	clamp := func(c *int, n int) {
		if *c >= n {
			*c = max(n-1, 0)
		}
	}
	clamp(&s.envCursor, len(d.EnvVars))
	clamp(&s.histCursor, len(d.ImageHistory))
	clamp(&s.svcCursor, len(d.Services))
	clamp(&s.domCursor, len(d.Ingresses))
	clamp(&s.volCursor, len(d.Volumes))
}

func (s *deploymentScreen) sizeLogVP() {
	bodyH := s.h - chromeH
	s.logVP.Width = s.w - s.overviewLeftW() - 4
	s.logVP.Height = bodyH - s.overviewInfoH() - 2
	if s.logVP.Height < 1 {
		s.logVP.Height = 1
	}
}

func (s *deploymentScreen) handleGlobalKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	switch msg.String() {
	case "esc":
		return pop, true
	case "]", "tab", "right":
		return s.setTab(s.tab + 1), true
	case "[", "left":
		return s.setTab(s.tab - 1), true
	case "1", "2", "3", "4", "5", "6", "7":
		return s.setTab(int(msg.String()[0] - '1')), true
	case "r":
		return tea.Batch(s.refresh(), s.tabDataCmd()), true
	}
	return nil, false
}

func (s *deploymentScreen) handleTabKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	switch s.tab {
	case tabOverview:
		return s.overviewKey(msg)
	case tabEnv:
		return s.envKey(msg)
	case tabDeploys:
		return s.deploysKey(msg)
	case tabNetwork:
		return s.networkKey(msg)
	case tabStorage:
		return s.storageKey(msg)
	case tabResources:
		return s.resourcesKey(msg)
	case tabAdvanced:
		return s.advancedKey(msg)
	}
	return nil, false
}

func (s *deploymentScreen) handleMouse(msg tea.MouseMsg) tea.Cmd {
	// click a tab in the panel border row (Y == 1)
	if msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress && msg.Y == 1 {
		for i, sp := range s.tabSpans {
			if msg.X >= sp[0] && msg.X <= sp[1] {
				return s.setTab(i)
			}
		}
	}
	switch msg.Button {
	case tea.MouseButtonWheelUp:
		s.wheel(-1, msg.X)
	case tea.MouseButtonWheelDown:
		s.wheel(1, msg.X)
	case tea.MouseButtonLeft:
		if msg.Action == tea.MouseActionPress && s.tab == tabOverview {
			if idx := s.hitPods.rowAt(msg.X, msg.Y, s.podCursor); idx >= 0 {
				s.podCursor = idx
			}
		}
	}
	return nil
}

// wheel scrolls whatever list sits under the pointer on the active tab.
func (s *deploymentScreen) wheel(dir, x int) {
	move := func(c *int, n int) {
		*c += dir
		if *c < 0 {
			*c = 0
		}
		if *c >= n && n > 0 {
			*c = n - 1
		}
		if n == 0 {
			*c = 0
		}
	}
	switch s.tab {
	case tabOverview:
		if x >= s.overviewLeftW() {
			if dir < 0 {
				s.logVP.LineUp(2)
			} else {
				s.logVP.LineDown(2)
			}
		} else {
			move(&s.podCursor, len(s.pods))
		}
	case tabEnv:
		if s.detail != nil {
			move(&s.envCursor, len(s.detail.EnvVars))
		}
	case tabDeploys:
		if s.deployPane == 0 && s.detail != nil {
			move(&s.histCursor, len(s.detail.ImageHistory))
		} else {
			move(&s.tokCursor, len(s.tokens))
		}
	case tabNetwork:
		if s.detail != nil {
			if s.netPane == 0 {
				move(&s.svcCursor, len(s.detail.Services))
			} else {
				move(&s.domCursor, len(s.detail.Ingresses))
			}
		}
	case tabStorage:
		if s.detail != nil {
			move(&s.volCursor, len(s.detail.Volumes))
		}
	case tabAdvanced:
		move(&s.auditCursor, len(s.audit))
	}
}

func (s *deploymentScreen) curReplicas() int {
	if s.detail != nil {
		return s.detail.Replicas
	}
	return 1
}

func (s *deploymentScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	if s.shellPicking {
		return []keyHint{{"↑/↓", "pod"}, {"enter", "open shell"}, {"esc", "cancel"}}
	}
	base := []keyHint{{"[/]", "tabs"}}
	switch s.tab {
	case tabOverview:
		base = append(base, keyHint{"f", "follow"}, keyHint{"b", "build/runtime"})
		if !s.execDenied {
			base = append(base, keyHint{"s", "shell"})
		}
		base = append(base, keyHint{"S", "scale"}, keyHint{"+/-", "replicas"},
			keyHint{"R", "restart"}, keyHint{"B", "rebuild"}, keyHint{"x", "delete"})
	case tabEnv:
		base = append(base, keyHint{"↑/↓", "move"}, keyHint{"e", "edit env"})
	case tabDeploys:
		base = append(base, keyHint{"p", "pane"}, keyHint{"↑/↓", "move"})
		if s.deployPane == 0 {
			base = append(base, keyHint{"R", "rollback"}, keyHint{"a", "auto-deploy"})
		} else {
			base = append(base, keyHint{"n", "new token"}, keyHint{"x", "delete token"})
		}
	case tabNetwork:
		base = append(base, keyHint{"p", "pane"}, keyHint{"↑/↓", "move"}, keyHint{"a", "add"})
		if s.netPane == 0 {
			base = append(base, keyHint{"e", "expose/unexpose"})
		} else {
			base = append(base, keyHint{"m", "protection"})
		}
		base = append(base, keyHint{"t", "tailscale"}, keyHint{"x", "delete"})
	case tabStorage:
		base = append(base, keyHint{"↑/↓", "move"}, keyHint{"a", "add volume"}, keyHint{"x", "remove"})
	case tabResources:
		base = append(base, keyHint{"e", "edit requests"})
	case tabAdvanced:
		base = append(base, keyHint{"t", "strategy"}, keyHint{"h", "health check"},
			keyHint{"g", "build-root"}, keyHint{"D", "depot"}, keyHint{"c", "cache"}, keyHint{"C", "cancel build"})
	}
	return append(base, keyHint{"r", "refresh"}, keyHint{"esc", "back"})
}

func (s *deploymentScreen) View() string {
	base := s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
	return s.shellPickerOverlay(base)
}

func (s *deploymentScreen) view() string {
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
	case tabOverview:
		return s.viewOverview(bodyH, strip)
	case tabEnv:
		return panelRaw(strip, s.viewEnv(bodyH), s.w, bodyH, true)
	case tabDeploys:
		return s.viewDeploys(bodyH, strip)
	case tabNetwork:
		return s.viewNetwork(bodyH, strip)
	case tabStorage:
		return panelRaw(strip, s.viewStorage(bodyH), s.w, bodyH, true)
	case tabResources:
		return panelRaw(strip, s.viewResources(bodyH), s.w, bodyH, true)
	case tabAdvanced:
		return s.viewAdvanced(bodyH, strip)
	}
	return ""
}

func (s *deploymentScreen) envKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	switch msg.String() {
	case "e", "enter":
		if s.detail != nil {
			return push(newEnvScreen(s.cl, s.id, s.detail.EnvVars)), true
		}
	case "up", "k":
		if s.envCursor > 0 {
			s.envCursor--
		}
		return nil, true
	case "down", "j":
		if s.detail != nil && s.envCursor < len(s.detail.EnvVars)-1 {
			s.envCursor++
		}
		return nil, true
	}
	return nil, false
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
		err := cl.Send(context.Background(), method, path, body, nil)
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
		return "-"
	}
	return s
}

func is403(err error) bool {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status == http.StatusForbidden
	}
	return err != nil && strings.Contains(err.Error(), "403")
}

func shortSha(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

func onOff(v bool) string {
	if v {
		return stGreen.Render("on")
	}
	return stMuted.Render("off")
}

func fmtDate(ts string) string {
	if len(ts) >= 16 {
		return strings.ReplaceAll(ts[:16], "T", " ")
	}
	return ts
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "-"
}

func fmtInt(n flexNum) string {
	return fmt.Sprintf("%d", int(n))
}
