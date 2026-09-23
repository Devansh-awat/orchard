package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/api"
)

// orchard top: one screen, no navigation, the canonical k9s/htop shape. It
// polls the same endpoints the web overview reads and stretches the poll
// interval while the org event stream is up, since the API allows 200
// requests a minute and a watcher left open should not spend them.

const (
	topPodsFast    = 5 * time.Second
	topPodsSlow    = 20 * time.Second
	topStatsEvery  = 30 * time.Second
	topSSEDebounce = 400 * time.Millisecond
)

type (
	topPodsMsg struct {
		pods  []map[string]any
		extra map[string]any
		err   error
	}
	topOverviewMsg struct {
		data map[string]any
		err  error
	}
	topMetricsMsg struct {
		data map[string]any
		err  error
	}
	topDetailMsg struct {
		data map[string]any
		err  error
	}
	topLiveMsg struct {
		data map[string]any
		err  error
	}
	topQueriesMsg struct {
		rows []map[string]any
		note string
		err  error
	}
	topTickMsg   struct{ what string }
	topSSEMsg    struct{ ev api.OrgEvent }
	topSSEErrMsg struct{ err error }
	topSSEEndMsg struct{}
	topActionMsg struct {
		text string
		err  error
	}
	topFlushMsg struct{}
)

type topModel struct {
	cl    *api.Client
	id    string
	db    bool
	orgID string
	w, h  int

	name, status string
	detail       map[string]any
	overview     map[string]any
	metrics      map[string]any
	pods         []map[string]any
	podsExtra    map[string]any
	live         map[string]any
	queries      []map[string]any
	queryNote    string

	sseUp     bool
	sseEvents <-chan api.OrgEvent
	sseErrs   <-chan error
	sseCancel context.CancelFunc
	pendingAt time.Time
	pending   bool

	refreshed time.Time
	flash     string
	flashErr  bool
	err       error
	cursor    int
}

// RunTop launches the single-screen watcher for one deployment or database.
func RunTop(cl *api.Client, id string, db bool, orgID string) error {
	m := &topModel{cl: cl, id: id, db: db, orgID: orgID}
	_, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	if m.sseCancel != nil {
		m.sseCancel()
	}
	return err
}

// RenderTopOnce fetches everything one time and returns the screen as plain
// text, for scripts and for checking the command without a terminal.
func RenderTopOnce(cl *api.Client, id string, db bool, w, h int) (string, error) {
	m := &topModel{cl: cl, id: id, db: db, w: w, h: h}
	cmds := []tea.Cmd{m.fetchDetail(), m.fetchPods()}
	if db {
		cmds = append(cmds, m.fetchQueries())
	} else {
		cmds = append(cmds, m.fetchOverview(), m.fetchMetrics())
	}
	for _, c := range cmds {
		m.Update(c())
	}
	if m.err != nil {
		return "", m.err
	}
	return m.View(), nil
}

func (m *topModel) Init() tea.Cmd {
	cmds := []tea.Cmd{m.fetchDetail(), m.fetchPods(), m.tick("pods"), m.tick("stats")}
	if m.db {
		cmds = append(cmds, m.fetchLive(), m.fetchQueries())
	} else {
		cmds = append(cmds, m.fetchOverview(), m.fetchMetrics())
	}
	if m.orgID != "" {
		cmds = append(cmds, m.startSSE())
	}
	return tea.Batch(cmds...)
}

func (m *topModel) basePath() string {
	if m.db {
		return "/databases/" + url.PathEscape(m.id)
	}
	return "/deployments/" + url.PathEscape(m.id)
}

func (m *topModel) fetchDetail() tea.Cmd {
	return func() tea.Msg {
		var raw map[string]any
		err := m.cl.GetJSON(context.Background(), m.basePath(), &raw)
		return topDetailMsg{raw, err}
	}
}

func (m *topModel) fetchPods() tea.Cmd {
	if m.db {
		return m.fetchLive()
	}
	return func() tea.Msg {
		var raw map[string]any
		err := m.cl.GetJSON(context.Background(), m.basePath()+"/pods-live", &raw)
		if err != nil {
			return topPodsMsg{nil, nil, err}
		}
		return topPodsMsg{asMaps(raw["pods"]), raw, nil}
	}
}

func (m *topModel) fetchOverview() tea.Cmd {
	return func() tea.Msg {
		var raw map[string]any
		err := m.cl.GetJSON(context.Background(), "/observe/deployments/"+url.PathEscape(m.id)+"/overview", &raw)
		return topOverviewMsg{raw, err}
	}
}

func (m *topModel) fetchMetrics() tea.Cmd {
	return func() tea.Msg {
		var raw map[string]any
		end := time.Now().UnixMilli()
		start := end - 30*60*1000
		path := fmt.Sprintf("%s/metrics?start=%d&end=%d&step=60000", m.basePath(), start, end)
		err := m.cl.GetJSON(context.Background(), path, &raw)
		return topMetricsMsg{raw, err}
	}
}

func (m *topModel) fetchLive() tea.Cmd {
	return func() tea.Msg {
		var raw map[string]any
		err := m.cl.GetJSON(context.Background(), m.basePath()+"/live", &raw)
		return topLiveMsg{raw, err}
	}
}

func (m *topModel) fetchQueries() tea.Cmd {
	return func() tea.Msg {
		var raw any
		err := m.cl.GetJSON(context.Background(), m.basePath()+"/query-stats", &raw)
		if err != nil {
			return topQueriesMsg{nil, "", err}
		}
		rows := asMaps(raw)
		note := ""
		if mm, ok := raw.(map[string]any); ok {
			if installed, ok := mm["installed"].(bool); ok && !installed {
				note = "pg_stat_statements is not installed on this database"
			}
			if len(rows) == 0 {
				for _, k := range []string{"queries", "rows", "data", "stats"} {
					if r := asMaps(mm[k]); len(r) > 0 {
						rows = r
						break
					}
				}
			}
		}
		sort.SliceStable(rows, func(i, j int) bool {
			return num(rows[i], "total_ms", "totalTime", "total_exec_time") > num(rows[j], "total_ms", "totalTime", "total_exec_time")
		})
		return topQueriesMsg{rows, note, nil}
	}
}

func (m *topModel) tick(what string) tea.Cmd {
	d := topStatsEvery
	if what == "pods" {
		d = topPodsFast
		if m.sseUp {
			d = topPodsSlow
		}
	}
	return tea.Tick(d, func(time.Time) tea.Msg { return topTickMsg{what} })
}

func (m *topModel) startSSE() tea.Cmd {
	ctx, cancel := context.WithCancel(context.Background())
	m.sseCancel = cancel
	events, errs := m.cl.SubscribeOrgEvents(ctx, m.orgID, "")
	m.sseEvents, m.sseErrs = events, errs
	return tea.Batch(m.waitSSE(), m.waitSSEErr())
}

func (m *topModel) waitSSE() tea.Cmd {
	ch := m.sseEvents
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return topSSEEndMsg{}
		}
		return topSSEMsg{ev}
	}
}

func (m *topModel) waitSSEErr() tea.Cmd {
	ch := m.sseErrs
	return func() tea.Msg {
		err, ok := <-ch
		if !ok {
			return topSSEEndMsg{}
		}
		return topSSEErrMsg{err}
	}
}

func (m *topModel) relevant(ev api.OrgEvent) bool {
	if ev.ID != m.id {
		return false
	}
	switch ev.Type {
	case "pod.changed", "deployment.changed", "build.changed", "database.changed":
		return true
	}
	return false
}

func (m *topModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		return m, nil
	case tea.KeyMsg:
		return m.key(msg)
	case topDetailMsg:
		if msg.err == nil {
			m.detail = msg.data
			m.name = firstStr(msg.data, "displayName", "name")
			m.status = firstStr(msg.data, "status")
		} else {
			m.err = msg.err
		}
		return m, nil
	case topPodsMsg:
		m.refreshed = time.Now()
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.err = nil
		m.pods, m.podsExtra = msg.pods, msg.extra
		if m.cursor >= len(m.pods) {
			m.cursor = max(0, len(m.pods)-1)
		}
		return m, nil
	case topOverviewMsg:
		if msg.err == nil {
			m.overview = msg.data
		}
		return m, nil
	case topMetricsMsg:
		if msg.err == nil {
			m.metrics = msg.data
		}
		return m, nil
	case topLiveMsg:
		m.refreshed = time.Now()
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.err = nil
		m.live = msg.data
		m.pods = asMaps(msg.data["pods"])
		if s := firstStr(msg.data, "status"); s != "" {
			m.status = s
		}
		return m, nil
	case topQueriesMsg:
		if msg.err == nil {
			m.queries = msg.rows
			m.queryNote = msg.note
		}
		return m, nil
	case topTickMsg:
		switch msg.what {
		case "pods":
			return m, tea.Batch(m.fetchPods(), m.tick("pods"))
		default:
			cmds := []tea.Cmd{m.tick("stats")}
			if m.db {
				cmds = append(cmds, m.fetchQueries(), m.fetchDetail())
			} else {
				cmds = append(cmds, m.fetchOverview(), m.fetchMetrics(), m.fetchDetail())
			}
			return m, tea.Batch(cmds...)
		}
	case topSSEMsg:
		m.sseUp = true
		cmds := []tea.Cmd{m.waitSSE()}
		if m.relevant(msg.ev) && !m.pending {
			m.pending = true
			cmds = append(cmds, tea.Tick(topSSEDebounce, func(time.Time) tea.Msg { return topFlushMsg{} }))
		}
		return m, tea.Batch(cmds...)
	case topFlushMsg:
		m.pending = false
		return m, tea.Batch(m.fetchPods(), m.fetchDetail())
	case topSSEErrMsg:
		m.sseUp = false
		return m, m.waitSSEErr()
	case topSSEEndMsg:
		m.sseUp = false
		return m, nil
	case topActionMsg:
		if msg.err != nil {
			m.flash, m.flashErr = msg.err.Error(), true
		} else {
			m.flash, m.flashErr = msg.text, false
		}
		return m, m.fetchPods()
	}
	return m, nil
}

func (m *topModel) key(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c", "esc":
		return m, tea.Quit
	case "r":
		m.flash = ""
		if m.db {
			return m, tea.Batch(m.fetchLive(), m.fetchQueries(), m.fetchDetail())
		}
		return m, tea.Batch(m.fetchPods(), m.fetchOverview(), m.fetchMetrics(), m.fetchDetail())
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.pods)-1 {
			m.cursor++
		}
	case "R":
		return m, m.action("POST", m.basePath()+"/restart", nil, "restart requested")
	case "+", "=":
		if !m.db {
			n := m.replicas() + 1
			return m, m.action("POST", m.basePath()+"/scale", map[string]any{"replicas": n}, fmt.Sprintf("scaling to %d", n))
		}
	case "-":
		if !m.db {
			if n := m.replicas() - 1; n >= 0 {
				return m, m.action("POST", m.basePath()+"/scale", map[string]any{"replicas": n}, fmt.Sprintf("scaling to %d", n))
			}
		}
	}
	return m, nil
}

func (m *topModel) action(method, path string, body any, ok string) tea.Cmd {
	return func() tea.Msg {
		err := m.cl.Send(context.Background(), method, path, body, nil)
		return topActionMsg{ok, err}
	}
}

func (m *topModel) replicas() int {
	if m.detail == nil {
		return 1
	}
	return int(num(m.detail, "replicas"))
}

func (m *topModel) View() string {
	if m.w == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString("\n")
	if m.db {
		b.WriteString(m.dbStrip())
	} else {
		b.WriteString(m.appStrip())
	}
	b.WriteString("\n\n")
	body := m.h - 7
	if m.db {
		b.WriteString(m.podTable(min(body/2, len(m.pods)+1)))
		b.WriteString("\n")
		b.WriteString(m.queryTable(body - min(body/2, len(m.pods)+1) - 1))
	} else {
		b.WriteString(m.podTable(body))
	}
	b.WriteString("\n")
	b.WriteString(m.footer())
	return b.String()
}

func (m *topModel) header() string {
	name := m.name
	if name == "" {
		name = m.id
	}
	kind := "app"
	if m.db {
		kind = "database"
	}
	left := stHeaderBar.Render(" orchard top ") + " " + stTitle.Render(name) + " " + stMuted.Render(kind) + "  " + statusDot(m.status)
	live := stMuted.Render("polling")
	if m.sseUp {
		live = stGreen.Render("● live")
	}
	age := "—"
	if !m.refreshed.IsZero() {
		age = fmt.Sprintf("%ds ago", int(time.Since(m.refreshed).Seconds()))
	}
	right := live + "  " + stMuted.Render("refreshed "+age)
	gap := m.w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

func (m *topModel) appStrip() string {
	cpu := seriesValues(m.metrics, "cpu")
	mem := seriesValues(m.metrics, "mem")
	var parts []string
	cpuNow, memNow := "—", "—"
	if m.podsExtra != nil {
		if v, ok := m.podsExtra["totalCpuUsage"].(float64); ok {
			cpuNow = fmtMilli(v)
		}
		if v, ok := m.podsExtra["totalMemoryUsage"].(float64); ok {
			memNow = topBytes(v)
		}
	}
	parts = append(parts, stKey.Render("CPU ")+sparkline(cpu, 14)+" "+cpuNow)
	parts = append(parts, stKey.Render("MEM ")+sparkline(mem, 14)+" "+memNow)
	if m.overview != nil {
		parts = append(parts, stKey.Render("req/s ")+fmtRate(m.overview["httpRequestRate"]))
		parts = append(parts, stKey.Render("5xx ")+fmtPct(m.overview["httpErrorRate"]))
		parts = append(parts, stKey.Render("latency ")+fmtLatency(m.overview["httpAvgLatency"]))
		parts = append(parts, stKey.Render("restarts ")+fmtCount(m.overview["restarts"]))
	}
	if m.detail != nil {
		ready := 0
		for _, p := range m.pods {
			if strings.EqualFold(firstStr(p, "status"), "ready") {
				ready++
			}
		}
		parts = append(parts, stKey.Render("replicas ")+fmt.Sprintf("%d/%d", ready, m.replicas()))
	}
	return " " + strings.Join(parts, "   ")
}

func (m *topModel) dbStrip() string {
	var parts []string
	if ls, ok := m.live["liveStatus"].(map[string]any); ok {
		if r, ok := ls["readyReplicas"].(float64); ok {
			parts = append(parts, stKey.Render("instances ")+fmt.Sprintf("%d/%d", int(r), int(num(ls, "replicas"))))
		}
		if rc := num(ls, "restartCount"); rc > 0 {
			parts = append(parts, stKey.Render("restarts ")+fmt.Sprintf("%d", int(rc)))
		}
		if msg := firstStr(ls, "message"); msg != "" {
			parts = append(parts, stMuted.Render(truncate(msg, 40)))
		}
	}
	if m.detail != nil {
		parts = append(parts, stKey.Render("storage ")+orDash(firstStr(m.detail, "storageSize")))
		parts = append(parts, stKey.Render("pg ")+orDash(firstStr(m.detail, "pgMajor", "version")))
	}
	parts = append(parts, stKey.Render("queries ")+fmt.Sprintf("%d", len(m.queries)))
	return " " + strings.Join(parts, "   ")
}

func (m *topModel) podTable(height int) string {
	cols := []struct {
		name string
		w    int
	}{{"POD", 0}, {"STATUS", 12}, {"RESTARTS", 9}, {"CPU", 8}, {"MEM", 9}, {"NODE", 14}, {"AGE", 7}}
	fixed := 0
	for _, c := range cols[1:] {
		fixed += c.w + 2
	}
	cols[0].w = max(12, m.w-fixed-3)
	var b strings.Builder
	b.WriteString(" ")
	for _, c := range cols {
		b.WriteString(stColHdr.Render(pad(c.name, c.w)) + "  ")
	}
	b.WriteString("\n")
	if len(m.pods) == 0 {
		b.WriteString(stMuted.Render("  no pods"))
		return b.String()
	}
	visible := max(1, height-1)
	start := clampStart(m.cursor, len(m.pods), visible)
	for i := start; i < len(m.pods) && i < start+visible; i++ {
		p := m.pods[i]
		row := " " +
			pad(truncate(firstStr(p, "name"), cols[0].w), cols[0].w) + "  " +
			padANSI(statusDot(firstStr(p, "status", "phase")), cols[1].w) + "  " +
			pad(fmtCount(p["restartCount"]), cols[2].w) + "  " +
			pad(fmtMilliAny(p["cpuUsage"]), cols[3].w) + "  " +
			pad(fmtBytesAny(p["memoryUsage"]), cols[4].w) + "  " +
			pad(truncate(orDash(firstStr(p, "nodeName", "node")), cols[5].w), cols[5].w) + "  " +
			pad(ageOf(firstStr(p, "startTime", "createdAt")), cols[6].w)
		if i == m.cursor {
			row = stSelBar.Render("▍") + row[1:]
		}
		b.WriteString(row + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *topModel) queryTable(height int) string {
	if height < 2 {
		return ""
	}
	var b strings.Builder
	b.WriteString(" " + stColHdr.Render(pad("QUERY", max(12, m.w-46))) + "  " +
		stColHdr.Render(pad("CALLS", 8)) + "  " + stColHdr.Render(pad("TOTAL", 9)) + "  " +
		stColHdr.Render(pad("MEAN", 8)) + "  " + stColHdr.Render(pad("ROWS", 8)) + "\n")
	if len(m.queries) == 0 {
		note := m.queryNote
		if note == "" {
			note = "no query stats yet"
		}
		b.WriteString(stMuted.Render("  " + note))
		return b.String()
	}
	qw := max(12, m.w-46)
	for i, q := range m.queries {
		if i >= height-1 {
			break
		}
		text := strings.Join(strings.Fields(firstStr(q, "query", "text", "sql")), " ")
		b.WriteString(" " + pad(truncate(text, qw), qw) + "  " +
			pad(fmtCount(q["calls"]), 8) + "  " +
			pad(fmtMs(num(q, "total_ms", "totalTime", "total_exec_time")), 9) + "  " +
			pad(fmtMs(num(q, "mean_ms", "meanTime", "mean_exec_time")), 8) + "  " +
			pad(fmtCount(q["rows"]), 8) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *topModel) footer() string {
	keys := "q quit  r refresh  R restart"
	if !m.db {
		keys += "  +/- scale"
	}
	line := " " + stFooter.Render(keys)
	if m.err != nil {
		line += "  " + stRed.Render(truncate(m.err.Error(), max(20, m.w-40)))
	} else if m.flash != "" {
		if m.flashErr {
			line += "  " + stRed.Render(m.flash)
		} else {
			line += "  " + stGreen.Render(m.flash)
		}
	}
	return line
}

func asMaps(v any) []map[string]any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if mm, ok := item.(map[string]any); ok {
			out = append(out, mm)
		}
	}
	return out
}

func firstStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		switch v := m[k].(type) {
		case string:
			if v != "" {
				return v
			}
		case float64:
			return fmt.Sprintf("%v", v)
		case json.Number:
			return v.String()
		}
	}
	return ""
}

func num(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		if v, ok := m[k].(float64); ok {
			return v
		}
	}
	return 0
}

func seriesValues(metrics map[string]any, key string) []float64 {
	if metrics == nil {
		return nil
	}
	data, _ := metrics["data"].(map[string]any)
	if data == nil {
		data = metrics
	}
	pts, _ := data[key].([]any)
	out := make([]float64, 0, len(pts))
	for _, p := range pts {
		if mm, ok := p.(map[string]any); ok {
			if y, ok := mm["y"].(float64); ok && !math.IsNaN(y) {
				out = append(out, y)
			}
		}
	}
	return out
}

var sparkChars = []rune("▁▂▃▄▅▆▇█")

func sparkline(values []float64, width int) string {
	if len(values) == 0 {
		return stMuted.Render(strings.Repeat("·", width))
	}
	if len(values) > width {
		values = values[len(values)-width:]
	}
	maxV := 0.0
	for _, v := range values {
		if v > maxV {
			maxV = v
		}
	}
	var b strings.Builder
	for i := 0; i < width-len(values); i++ {
		b.WriteRune(' ')
	}
	for _, v := range values {
		idx := 0
		if maxV > 0 {
			idx = int(math.Round(v / maxV * float64(len(sparkChars)-1)))
		}
		b.WriteRune(sparkChars[idx])
	}
	return stAccent.Render(b.String())
}

func fmtMilli(v float64) string {
	if v >= 1000 {
		return fmt.Sprintf("%.2f cores", v/1000)
	}
	return fmt.Sprintf("%dm", int(math.Round(v)))
}

func fmtMilliAny(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return fmtMilli(f)
}

func topBytes(v float64) string {
	const mb = 1024 * 1024
	if v >= 1024*mb {
		return fmt.Sprintf("%.1f GB", v/(1024*mb))
	}
	return fmt.Sprintf("%d MB", int(math.Round(v/mb)))
}

func fmtBytesAny(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return topBytes(f)
}

func fmtCount(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return fmt.Sprintf("%d", int(f))
}

func fmtRate(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return fmt.Sprintf("%.1f", f)
}

func fmtPct(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return fmt.Sprintf("%.2f%%", f*100)
}

func fmtLatency(v any) string {
	f, ok := v.(float64)
	if !ok {
		return "—"
	}
	return fmtMs(f * 1000)
}

func fmtMs(ms float64) string {
	if ms <= 0 {
		return "—"
	}
	if ms >= 1000 {
		return fmt.Sprintf("%.2fs", ms/1000)
	}
	return fmt.Sprintf("%.0fms", ms)
}

func ageOf(ts string) string {
	if ts == "" {
		return "—"
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return "—"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func padANSI(s string, w int) string {
	if n := w - lipgloss.Width(s); n > 0 {
		return s + strings.Repeat(" ", n)
	}
	return s
}
