package tui

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/coder/websocket"
	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/hackclub/orchard/cli/internal/termsession"
)

var dbTabs = []string{"Connection", "Backups", "Extensions", "Metrics", "Resources", "Settings"}

// databaseScreen is the database detail view at frontend parity: the six web
// tabs plus the Terminal tab mapped to the 's' key (interactive psql).
type databaseScreen struct {
	cl       *api.Client
	project  Project
	id, name string
	tab      int

	detail    *dbDetail
	backups   []dbBackup
	schedule  string
	exts      []dbExtension
	preload   []string
	params    map[string]string
	paramKeys []string
	metrics   dbMetricsResp
	prov      *dbProvisioning

	reveal    bool
	conn      *dbConnection
	bakCursor int
	extCursor int
	setCursor int
	tabSpans  [][2]int
	tabY      int // absolute Y of the tab strip row (shifts when the banner shows)
	hitBak    hitTable
	hitExt    hitTable
	confirm   confirmModel
	loading   bool
	sseLive   bool
	tickGen   int
	w, h      int
}

func newDatabaseScreen(cl *api.Client, p Project, id, name string) *databaseScreen {
	return &databaseScreen{cl: cl, project: p, id: id, name: name, loading: true, tabY: 1}
}

func (s *databaseScreen) title() string { return s.name }
func (s *databaseScreen) orgID() string { return s.project.OrganizationID }

func (s *databaseScreen) Init() tea.Cmd {
	return tea.Batch(s.refetchAll(), s.tick())
}

func (s *databaseScreen) refetchAll() tea.Cmd {
	return tea.Batch(
		fetchDBDetail(s.cl, s.id),
		fetchDBBackups(s.cl, s.id),
		fetchDBExtensions(s.cl, s.id),
		fetchDBSettings(s.cl, s.id),
		fetchDBSchedule(s.cl, s.id),
		fetchDBMetrics(s.cl, s.id),
	)
}

func (s *databaseScreen) tickEvery() time.Duration {
	if s.sseLive {
		return refreshEverySSE
	}
	return refreshEvery
}

func (s *databaseScreen) tick() tea.Cmd {
	gen := s.tickGen
	return tea.Tick(s.tickEvery(), func(time.Time) tea.Msg { return tickMsg{s.id, gen} })
}

// OnOrgEvent refetches the database the moment the org bus reports it changed.
func (s *databaseScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	if ev.ID != s.id {
		return nil
	}
	if ev.Type == "database.changed" {
		return s.refetchAll()
	}
	return nil
}

// provisioningActive mirrors the frontend gate for the provisioning panel:
// cnpg databases that are provisioning/restoring, or errored without a ready
// pod, keep polling GET /databases/:id/provisioning.
func (s *databaseScreen) provisioningActive() bool {
	if s.detail == nil {
		return false
	}
	switch lc(s.detail.Status) {
	case "provisioning", "restoring":
		return true
	case "error":
		return s.detail.LiveStatus == nil || !s.detail.LiveStatus.Ready
	}
	return false
}

func (s *databaseScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case tickMsg:
		if msg.id == s.id && msg.gen == s.tickGen {
			cmds := []tea.Cmd{fetchDBDetail(s.cl, s.id), s.tick()}
			if s.provisioningActive() {
				cmds = append(cmds, fetchDBProvisioning(s.cl, s.id))
			}
			if s.tab == 3 {
				cmds = append(cmds, fetchDBMetrics(s.cl, s.id))
			}
			return s, tea.Batch(cmds...)
		}
	case sseStatusMsg:
		if s.sseLive != msg.connected {
			s.sseLive = msg.connected
			s.tickGen++
			return s, s.tick()
		}
	case dbDetailMsg:
		s.loading = false
		if msg.err != nil {
			return s, nil
		}
		s.detail = msg.d
		if s.provisioningActive() {
			return s, fetchDBProvisioning(s.cl, s.id)
		}
		s.prov = nil
	case dbBackupsMsg:
		if msg.err == nil {
			s.backups = msg.items
			if s.bakCursor >= len(s.backups) {
				s.bakCursor = 0
			}
		}
	case dbExtensionsMsg:
		if msg.err == nil {
			s.exts, s.preload = msg.exts, msg.preload
			if s.extCursor >= len(s.exts) {
				s.extCursor = 0
			}
		}
	case dbSettingsMsg:
		if msg.err == nil {
			s.params = msg.params
			s.paramKeys = s.paramKeys[:0]
			for k := range s.params {
				s.paramKeys = append(s.paramKeys, k)
			}
			sort.Strings(s.paramKeys)
			if s.setCursor >= len(s.paramKeys) {
				s.setCursor = 0
			}
		}
	case dbScheduleMsg:
		if msg.err == nil {
			s.schedule = msg.cron
		}
	case dbMetricsMsg:
		if msg.err == nil {
			s.metrics = msg.m
		}
	case dbProvisioningMsg:
		if msg.err == nil {
			s.prov = msg.p
		}
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refetchAll(), flashf("%s", msg.text))
	case dbChangedMsg:
		return s, tea.Batch(s.refetchAll(), flashf("%s", msg.text))
	case dbShellDoneMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, s.refetchAll()
	case dbConnectionMsg:
		if msg.err != nil {
			s.reveal = false
			return s, errFlash(msg.err)
		}
		s.conn = msg.c
		s.reveal = true
	case tea.MouseMsg:
		return s.updateMouse(msg)
	case tea.KeyMsg:
		return s.updateKey(msg)
	}
	return s, nil
}

func (s *databaseScreen) updateMouse(msg tea.MouseMsg) (screen, tea.Cmd) {
	if msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress && msg.Y == s.tabY {
		for i, sp := range s.tabSpans {
			if msg.X >= sp[0] && msg.X <= sp[1] {
				if s.tab != i {
					s.tab = i
					return s, s.tabCmd()
				}
				return s, nil
			}
		}
	}
	switch msg.Button {
	case tea.MouseButtonWheelUp:
		s.moveCursor(-1)
	case tea.MouseButtonWheelDown:
		s.moveCursor(1)
	case tea.MouseButtonLeft:
		if msg.Action == tea.MouseActionPress {
			if s.tab == 1 {
				if idx := s.hitBak.rowAt(msg.X, msg.Y, s.bakCursor); idx >= 0 {
					s.bakCursor = idx
				}
			} else if s.tab == 2 {
				if idx := s.hitExt.rowAt(msg.X, msg.Y, s.extCursor); idx >= 0 {
					s.extCursor = idx
				}
			}
		}
	}
	return s, nil
}

func (s *databaseScreen) moveCursor(delta int) {
	move := func(cur *int, count int) {
		n := *cur + delta
		if n >= 0 && n < count {
			*cur = n
		}
	}
	switch s.tab {
	case 1:
		move(&s.bakCursor, len(s.backups))
	case 2:
		move(&s.extCursor, len(s.exts))
	case 5:
		move(&s.setCursor, len(s.paramKeys))
	}
}

func (s *databaseScreen) updateKey(msg tea.KeyMsg) (screen, tea.Cmd) {
	switch msg.String() {
	case "esc":
		return s, pop
	case "tab", "right":
		s.tab = (s.tab + 1) % len(dbTabs)
		return s, s.tabCmd()
	case "left", "h":
		s.tab = (s.tab - 1 + len(dbTabs)) % len(dbTabs)
		return s, s.tabCmd()
	case "1", "2", "3", "4", "5", "6":
		s.tab = int(msg.String()[0] - '1')
		return s, s.tabCmd()
	case "s":
		return s, s.openShell()
	case "r":
		if s.tab == 0 {
			if s.reveal {
				s.reveal = false
				s.conn = nil
				return s, nil
			}
			return s, fetchDBConnection(s.cl, s.id)
		}
		return s, s.refetchAll()
	case "p":
		if s.tab == 0 && s.detail != nil {
			if s.detail.PublicEnabled {
				s.confirm.Show(fmt.Sprintf("Stop exposing %q publicly? Clients on the public endpoint are disconnected.", s.name),
					doAction(s.cl, "DELETE", dbPath(s.id)+"/public", nil, "public access off"))
			} else {
				s.confirm.Show(fmt.Sprintf("Expose database %q on the organization's shared IP with TLS?", s.name),
					doAction(s.cl, "POST", dbPath(s.id)+"/public", map[string]any{}, "public access on"))
			}
			return s, nil
		}
	case "b":
		if s.tab == 1 {
			return s, doAction(s.cl, "POST", dbPath(s.id)+"/backups", map[string]any{}, "backup started")
		}
	case "R":
		if s.tab == 1 && s.bakCursor < len(s.backups) {
			b := s.backups[s.bakCursor]
			s.confirm.Show(fmt.Sprintf("Restore %q? This REPLACES all current data in %s.", dbBackupLabel(b), s.name),
				doAction(s.cl, "POST", dbPath(s.id)+"/restore", map[string]any{"backupId": b.ID}, "restore started"))
			return s, nil
		}
	case "S":
		if s.tab == 1 {
			return s, push(newDBScheduleScreen(s.cl, s.id, s.schedule))
		}
	case "i":
		if s.tab == 2 {
			return s, push(newDBExtInstallScreen(s.cl, s.id))
		}
	case "x":
		if s.tab == 2 && s.extCursor < len(s.exts) {
			e := s.exts[s.extCursor]
			s.confirm.Show(fmt.Sprintf("Drop extension %q? Objects that depend on it are dropped too.", e.Name),
				doAction(s.cl, "DELETE", dbPath(s.id)+"/extensions/"+url.PathEscape(e.Name), nil, "uninstalled "+e.Name))
			return s, nil
		}
	case "e":
		if s.tab == 4 && s.detail != nil {
			return s, push(newDBResourcesScreen(s.cl, s.id, s.detail))
		}
		if s.tab == 5 {
			return s, push(newDBSettingsScreen(s.cl, s.id, s.params))
		}
	case "g":
		if s.tab == 4 {
			cur := ""
			if s.detail != nil {
				cur = s.detail.StorageSize
			}
			return s, push(newDBStorageScreen(s.cl, s.id, cur))
		}
	case "up", "k":
		s.moveCursor(-1)
	case "down", "j":
		s.moveCursor(1)
	}
	return s, nil
}

// tabCmd refreshes data that goes stale fastest when a tab is opened.
func (s *databaseScreen) tabCmd() tea.Cmd {
	if s.tab == 3 {
		return fetchDBMetrics(s.cl, s.id)
	}
	return nil
}

func (s *databaseScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	switch s.tab {
	case 0:
		return []keyHint{{"←/→", "tabs"}, {"r", "reveal"}, {"p", "public"}, {"s", "psql"}, {"esc", "back"}}
	case 1:
		return []keyHint{{"←/→", "tabs"}, {"↑/↓", "move"}, {"b", "backup"}, {"R", "restore"},
			{"S", "schedule"}, {"s", "psql"}, {"r", "refresh"}, {"esc", "back"}}
	case 2:
		return []keyHint{{"←/→", "tabs"}, {"↑/↓", "move"}, {"i", "install"}, {"x", "uninstall"},
			{"s", "psql"}, {"r", "refresh"}, {"esc", "back"}}
	case 4:
		return []keyHint{{"←/→", "tabs"}, {"e", "edit"}, {"g", "grow storage"}, {"s", "psql"},
			{"r", "refresh"}, {"esc", "back"}}
	case 5:
		return []keyHint{{"←/→", "tabs"}, {"↑/↓", "move"}, {"e", "edit"}, {"s", "psql"},
			{"r", "refresh"}, {"esc", "back"}}
	}
	return []keyHint{{"←/→", "tabs"}, {"s", "psql"}, {"r", "refresh"}, {"esc", "back"}}
}

func (s *databaseScreen) View() string {
	return s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
}

func (s *databaseScreen) view() string {
	if s.loading && s.detail == nil {
		return stMuted.Render("\n  loading database…")
	}
	bodyH := s.h - chromeH
	banner := s.provBanner()
	base := 0
	if banner != "" {
		base = 1
		bodyH--
	}
	s.tabY = 1 + base

	strip := renderTabs(dbTabs, s.tab)
	spans := make([][2]int, len(dbTabs))
	x := 4 // "╭─┤ " before the strip
	for i, t := range dbTabs {
		spans[i] = [2]int{x, x + len(t) - 1}
		x += len(t) + 3 // " · " separator
	}
	s.tabSpans = spans

	var body string
	switch s.tab {
	case 0:
		body = panelRaw(strip, s.viewConnection(), s.w, bodyH, true)
	case 1:
		s.hitBak = hitTable{topY: 6 + base, visible: bodyH - 6, count: len(s.backups), minX: 0, maxX: s.w - 1}
		body = panelRaw(strip, s.viewBackups(bodyH), s.w, bodyH, true)
	case 2:
		s.hitExt = hitTable{topY: 6 + base, visible: bodyH - 6, count: len(s.exts), minX: 0, maxX: s.w - 1}
		body = panelRaw(strip, s.viewExtensions(bodyH), s.w, bodyH, true)
	case 3:
		body = panelRaw(strip, s.viewMetrics(bodyH), s.w, bodyH, true)
	case 4:
		body = panelRaw(strip, s.viewResources(), s.w, bodyH, true)
	case 5:
		body = panelRaw(strip, s.viewSettings(bodyH), s.w, bodyH, true)
	}
	if banner != "" {
		return banner + "\n" + body
	}
	return body
}

// provBanner is the one-line provisioning/restore status shown above the tabs
// while the cluster is still coming up (frontend: DatabaseProvisioning).
func (s *databaseScreen) provBanner() string {
	if !s.provisioningActive() {
		return ""
	}
	txt := " " + badge(s.detail.Status)
	if s.prov != nil {
		done, total := 0, len(s.prov.Steps)
		cur := ""
		for _, st := range s.prov.Steps {
			if st.Status == "done" {
				done++
			}
			if st.Status == "running" && cur == "" {
				cur = st.Label
			}
		}
		info := ""
		if total > 0 {
			info = fmt.Sprintf(" %d/%d steps", done, total)
		}
		if cur != "" {
			info += " · " + cur
		} else if s.prov.Phase != "" {
			info += " · " + s.prov.Phase
		}
		if s.prov.Failed {
			info += " · " + stRed.Render("failed")
		}
		txt += stMuted.Render(info)
	}
	return txt
}

func (s *databaseScreen) viewConnection() string {
	d := s.detail
	if d == nil {
		return stMuted.Render("  no data")
	}
	var b strings.Builder
	row := func(k, v string) {
		b.WriteString(stKey.Render(pad(k, 13)) + " " + v + "\n")
	}
	row("Status", badge(d.Status))
	if d.LiveStatus != nil {
		if d.LiveStatus.Size != "" {
			row("Size", d.LiveStatus.Size)
		}
		row("Connections", fmt.Sprintf("%.0f", float64(d.LiveStatus.Connections)))
	}
	b.WriteString("\n")
	row("Host", d.Host)
	row("Port", dbPortStr(d.Port))
	row("Database", d.DBName)
	row("User", d.DBUser)
	pw := strings.Repeat("•", 12)
	cs := dbMaskedConnStr(d)
	if s.reveal && s.conn != nil {
		pw, cs = s.conn.Password, s.conn.ConnectionString
	}
	row("Password", pw)
	row("URL", stMuted.Render(cs))
	b.WriteString("\n")
	if d.PublicEnabled {
		row("Public", stGreen.Render("● enabled"))
		host := d.PublicHostname
		if host == "" {
			host = d.PublicIP
		}
		row("Public host", host)
		row("Public port", dbPortStr(d.PublicPort))
		if d.PublicConnStr != "" {
			pcs := dbMaskedPublicConnStr(d)
			if s.reveal && s.conn != nil && s.conn.PublicConnectionString != "" {
				pcs = s.conn.PublicConnectionString
			}
			row("Public URL", stMuted.Render(pcs))
		}
	} else {
		row("Public", stMuted.Render("off, press p to make it public on the organization's shared IP"))
	}
	return b.String()
}

func (s *databaseScreen) viewBackups(height int) string {
	sched := s.schedule
	if sched == "" {
		sched = stMuted.Render("(none)")
	}
	head := stKey.Render(pad("Schedule", 13)) + " " + sched + stMuted.Render("  · cron, UTC · press S to edit")
	rows := make([][]string, len(s.backups))
	for i, b := range s.backups {
		size := ""
		if b.SizeBytes > 0 {
			size = fmtBytes(float64(b.SizeBytes))
		}
		rows[i] = []string{
			dbBackupLabel(b),
			orDash(b.Type),
			statusDot(b.Status),
			orDash(size),
			stMuted.Render(orDash(b.CreatedAt)),
		}
	}
	cols := []col{{title: "LABEL"}, {title: "TYPE"}, {title: "STATUS"}, {title: "SIZE"}, {title: "CREATED"}}
	return head + "\n\n" + renderTable(cols, rows, s.bakCursor, s.w-2, height-4)
}

func (s *databaseScreen) viewExtensions(height int) string {
	pre := stMuted.Render("(none)")
	if len(s.preload) > 0 {
		pre = strings.Join(s.preload, ", ")
	}
	head := stKey.Render(pad("Preload", 13)) + " " + pre + stMuted.Render("  · shared_preload_libraries")
	rows := make([][]string, len(s.exts))
	for i, e := range s.exts {
		installed := ""
		if e.Installed {
			installed = stGreen.Render("yes")
		}
		rows[i] = []string{
			e.Name,
			installed,
			orDash(e.Version),
			orDash(e.DefaultVersion),
			stMuted.Render(truncate(e.Comment, 48)),
		}
	}
	cols := []col{{title: "NAME"}, {title: "INSTALLED"}, {title: "VERSION"}, {title: "DEFAULT"}, {title: "COMMENT"}}
	return head + "\n\n" + renderTable(cols, rows, s.extCursor, s.w-2, height-4)
}

func (s *databaseScreen) viewMetrics(height int) string {
	colW := (s.w - 5) / 2
	graphH := (height - 2 - 5) / 2
	if graphH < 2 {
		graphH = 2
	}
	block := func(title, val string, pts []dbXY) string {
		return stKey.Render(title) + "  " + stGreen.Render(val) + "\n" + brailleGraph(dbYs(pts), colW, graphH)
	}
	d := s.metrics.Data
	top := lipgloss.JoinHorizontal(lipgloss.Top,
		block("CPU", dbLastY(d.CPU, "%.0fm"), d.CPU), " ",
		block("Memory", dbLastY(d.Mem, "%.0f MiB"), d.Mem))
	bot := lipgloss.JoinHorizontal(lipgloss.Top,
		block("Net RX", dbLastY(d.RX, "%.1f KiB/s"), d.RX), " ",
		block("Net TX", dbLastY(d.TX, "%.1f KiB/s"), d.TX))
	mode := "○ polling"
	if s.sseLive {
		mode = "● live"
	}
	foot := stMuted.Render(fmt.Sprintf("⟳ %s · refresh every %s", mode, s.tickEvery()))
	return top + "\n\n" + bot + "\n" + foot
}

func (s *databaseScreen) viewResources() string {
	d := s.detail
	if d == nil {
		return stMuted.Render("  no data")
	}
	var b strings.Builder
	row := func(k, v string) {
		b.WriteString(stKey.Render(pad(k, 13)) + " " + v + "\n")
	}
	cpu := stMuted.Render("default")
	if d.CPURequestMilli > 0 {
		cpu = fmtCPU(float64(d.CPURequestMilli))
	}
	mem := stMuted.Render("default")
	if d.MemoryRequestB > 0 {
		mem = fmtBytes(float64(d.MemoryRequestB))
	}
	row("CPU", cpu)
	row("Memory", mem)
	row("Storage", orDash(d.StorageSize))
	b.WriteString("\n" + stMuted.Render("e edit cpu/memory (restarts the pod) · g grow the storage volume (never shrinks)"))
	return b.String()
}

func (s *databaseScreen) viewSettings(height int) string {
	if len(s.paramKeys) == 0 {
		return stMuted.Render("  no parameters set, press e to edit postgresql.conf overrides")
	}
	rows := make([][]string, len(s.paramKeys))
	for i, k := range s.paramKeys {
		rows[i] = []string{stKey.Render(k), s.params[k]}
	}
	return renderTable([]col{{title: "PARAMETER"}, {title: "VALUE"}}, rows, s.setCursor, s.w-2, height-2)
}

// openShell suspends the TUI and runs psql in the database pod, resolving the
// target exactly like `orchard db psql`: pods[0], container postgres, the
// database's namespace, exec-ing psql with the platform connection string.
func (s *databaseScreen) openShell() tea.Cmd {
	d := s.detail
	if d == nil || d.Namespace == "" || len(d.Pods) == 0 || d.Pods[0].Name == "" {
		status := ""
		if d != nil {
			status = d.Status
		}
		return errFlash(fmt.Errorf("database has no running pod yet (status: %s)", status))
	}
	ex := &dbShellExec{cl: s.cl, id: s.id, pod: d.Pods[0].Name, namespace: d.Namespace}
	return tea.Exec(ex, func(err error) tea.Msg { return dbShellDoneMsg{err} })
}

// dbShellExec is the tea.ExecCommand that pumps the pod-exec websocket against
// the real terminal while bubbletea is suspended.
type dbShellExec struct {
	cl                             *api.Client
	id, pod, namespace, connString string
	stdin                          io.Reader
	stdout                         io.Writer
}

func (e *dbShellExec) SetStdin(r io.Reader)  { e.stdin = r }
func (e *dbShellExec) SetStdout(w io.Writer) { e.stdout = w }
func (e *dbShellExec) SetStderr(io.Writer)   {}

func (e *dbShellExec) Run() error {
	ctx := context.Background()
	if e.connString == "" && e.id != "" {
		c, err := getDBConnection(ctx, e.cl, e.id)
		if err != nil {
			return err
		}
		e.connString = c.ConnectionString
	}
	conn, err := e.cl.DialExec(ctx, e.pod, e.namespace, "postgres")
	if err != nil {
		return err
	}
	// The exec gateway always spawns a shell; exec into psql so quitting psql
	// ends the session (same as cmd/db.go psql).
	if e.connString != "" {
		if err := conn.Write(ctx, websocket.MessageText, []byte("exec psql \""+e.connString+"\"\n")); err != nil {
			return err
		}
	}
	return termsession.Run(ctx, conn, e.stdin, e.stdout)
}

func dbBackupLabel(b dbBackup) string {
	if b.Label != "" {
		return b.Label
	}
	if b.BackupName != "" {
		return b.BackupName
	}
	return b.ID
}

func dbPortStr(p flexNum) string {
	if p <= 0 {
		return "-"
	}
	return fmt.Sprintf("%.0f", float64(p))
}

func dbMaskedConnStr(d *dbDetail) string {
	return fmt.Sprintf("postgresql://%s:••••••••@%s:%s/%s", d.DBUser, d.Host, dbPortStr(d.Port), d.DBName)
}

func dbMaskedPublicConnStr(d *dbDetail) string {
	host := d.PublicHostname
	if host == "" {
		host = d.PublicIP
	}
	return fmt.Sprintf("postgresql://%s:••••••••@%s:%s/%s?sslmode=verify-full", d.DBUser, host, dbPortStr(d.PublicPort), d.DBName)
}
