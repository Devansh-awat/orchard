package tui

import (
	"fmt"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// chromeH is the number of lines the root reserves for the header + footer.
const chromeH = 2

type keyHint = [2]string

// screen is one navigable view. Update returns the (possibly new) screen so
// screens can swap themselves in place without the root knowing their type.
type screen interface {
	Init() tea.Cmd
	Update(tea.Msg) (screen, tea.Cmd)
	View() string
	title() string
	help() []keyHint
}

// orgEventHandler is an optional screen extension: screens implementing it
// receive live org-bus events forwarded by the root (debounced per entity,
// see sse.go) and return whatever refresh commands they need.
type orgEventHandler interface {
	OnOrgEvent(ev api.OrgEvent) tea.Cmd
}

// navigation + status messages
type (
	pushScreen    struct{ s screen }
	replaceScreen struct{ s screen }
	popScreen     struct{}
	flash         struct {
		text  string
		isErr bool
	}
)

func push(s screen) tea.Cmd    { return func() tea.Msg { return pushScreen{s} } }
func replace(s screen) tea.Cmd { return func() tea.Msg { return replaceScreen{s} } }
func pop() tea.Msg             { return popScreen{} }
func flashf(f string, a ...any) tea.Cmd {
	return func() tea.Msg { return flash{fmt.Sprintf(f, a...), false} }
}
func errFlash(err error) tea.Cmd {
	return func() tea.Msg { return flash{err.Error(), true} }
}

type model struct {
	cl     *api.Client
	w, h   int
	stack  []screen
	status string
	stErr  bool
	sse    sseState
}

func (m model) top() screen { return m.stack[len(m.stack)-1] }

func (m model) Init() tea.Cmd { return m.top().Init() }

func (m model) resizeTop() tea.Cmd {
	return func() tea.Msg { return tea.WindowSizeMsg{Width: m.w, Height: m.h} }
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if cmd, handled := m.handleSSEMsg(msg); handled {
		return m, cmd
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		// fall through to deliver to the top screen too

	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		// global overlays: suppressed while the top screen is capturing text
		// (forms, env editor, the overlays themselves) or showing a modal
		if !grabsKeys(m.top()) {
			switch msg.String() {
			case "o":
				return m, push(newSwitcherScreen(m.cl, m.sse.orgID, stackProject(m.stack)))
			case "ctrl+k", "/":
				return m, push(newSearchScreen(m.cl, m.sse.orgID))
			}
		}

	case orgSelectedMsg:
		// org switcher: collapse to a fresh projects list and re-point the
		// event bus at the selected org
		m.stack = []screen{newProjectsScreen(m.cl)}
		m.status = ""
		cmds := []tea.Cmd{m.top().Init(), m.resizeTop(), m.notifySSEStatus(),
			flashf("switched to %s", msg.org.Name)}
		if msg.org.ID != m.sse.orgID {
			cmds = append(cmds, m.startSSE(msg.org.ID, ""))
		}
		return m, tea.Batch(cmds...)

	case pushScreen:
		m.stack = append(m.stack, msg.s)
		m.status = ""
		return m, tea.Batch(msg.s.Init(), m.resizeTop(),
			m.switchSSE(screenOrg(msg.s)), m.notifySSEStatus())

	case replaceScreen:
		m.stack[len(m.stack)-1] = msg.s
		m.status = ""
		return m, tea.Batch(msg.s.Init(), m.resizeTop(),
			m.switchSSE(screenOrg(msg.s)), m.notifySSEStatus())

	case popScreen:
		if len(m.stack) > 1 {
			m.stack = m.stack[:len(m.stack)-1]
			m.status = ""
		}
		return m, m.resizeTop()

	case flash:
		m.status, m.stErr = msg.text, msg.isErr
		return m, nil

	case projectsMsg:
		// the root piggybacks on the projects fetch to learn the active org
		// for the event subscription; the message still flows to the screen
		var boot tea.Cmd
		if msg.err == nil && m.sse.orgID == "" {
			if org := orgFromProjects(msg.items); org != "" {
				boot = m.switchSSE(org)
			} else {
				boot = fetchRootOrgs(m.cl)
			}
		}
		top, cmd := m.top().Update(msg)
		m.stack[len(m.stack)-1] = top
		return m, tea.Batch(cmd, boot)
	}

	top, cmd := m.top().Update(msg)
	m.stack[len(m.stack)-1] = top
	return m, cmd
}

func (m model) View() string {
	if m.w == 0 {
		return "loading…"
	}
	header := m.headerBar()
	footer := m.bottomBar()
	body := m.top().View()
	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m model) headerBar() string {
	brand := stHeaderBar.Render(" Orchard ")
	parts := make([]string, len(m.stack))
	for i, s := range m.stack {
		st := stBarMuted
		if i == len(m.stack)-1 {
			st = stBarText.Bold(true)
		}
		parts[i] = st.Render(s.title())
	}
	crumb := strings.Join(parts, stBarMuted.Render(" › "))
	left := brand + stBarMuted.Render("  ") + crumb

	// live indicator: ● live while the org event stream delivers, ○ polling
	// while screens are on their fast-poll fallback
	live := stBarMuted.Render("○ polling ")
	if m.sse.connected {
		live = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colGreen)).
			Background(lipgloss.Color(colHeaderBg)).
			Render("● live ")
	}
	bg := lipgloss.NewStyle().Background(lipgloss.Color(colHeaderBg))
	gap := m.w - lipgloss.Width(left) - lipgloss.Width(live)
	if gap < 0 {
		gap = 0
	}
	// One solid bar: lipgloss pads any remainder with the bar background, so it
	// never depends on hand-counted widths.
	return lipgloss.NewStyle().Background(lipgloss.Color(colHeaderBg)).Width(m.w).MaxHeight(1).
		Render(left + bg.Render(strings.Repeat(" ", gap)) + live)
}

// renderTabs builds an inline tab strip ("Overview · Pods · Logs · Env") for
// embedding in a panel border, so it doesn't need its own row.
func renderTabs(tabs []string, active int) string {
	segs := make([]string, len(tabs))
	for i, t := range tabs {
		if i == active {
			segs[i] = stTabSel.Render(t)
		} else {
			segs[i] = stMuted.Render(t)
		}
	}
	return strings.Join(segs, stMuted.Render(" · "))
}

// bottomBar renders the bagels/gh-dash style key bar: accented key chips + muted
// labels on the left, a status flash on the right.
func (m model) bottomBar() string {
	bg := lipgloss.NewStyle().Background(lipgloss.Color(colHeaderBg))
	keyS := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colLogo)).Background(lipgloss.Color(colHeaderBg))
	lblS := lipgloss.NewStyle().Foreground(lipgloss.Color(colMuted)).Background(lipgloss.Color(colHeaderBg))

	parts := make([]string, 0)
	for _, h := range m.top().help() {
		parts = append(parts, keyS.Render(" "+h[0]+" ")+lblS.Render(h[1]+" "))
	}
	// global overlay shortcuts, hidden while the top screen captures raw keys
	if !grabsKeys(m.top()) {
		for _, h := range []keyHint{{"o", "org"}, {"ctrl+k", "search"}} {
			parts = append(parts, keyS.Render(" "+h[0]+" ")+lblS.Render(h[1]+" "))
		}
	}
	left := bg.Render(" ") + strings.Join(parts, bg.Render(" "))

	right := ""
	if m.status != "" {
		st := stGreen
		icon := "✓ "
		if m.stErr {
			st, icon = stRed, "✗ "
		}
		right = lipgloss.NewStyle().Background(lipgloss.Color(colHeaderBg)).Foreground(st.GetForeground()).Render(icon + m.status + " ")
	}
	gap := m.w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 0 {
		gap = 0
	}
	return left + bg.Render(strings.Repeat(" ", gap)) + right
}

// Run launches the dashboard rooted at the projects list.
func Run(cl *api.Client) error {
	m := model{cl: cl, stack: []screen{newSplashScreen(cl)}}
	_, err := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion()).Run()
	return err
}

// clampStart computes the first visible row index for a scrolling table.
func clampStart(cursor, count, visible int) int {
	if count <= visible || visible < 1 {
		return 0
	}
	start := cursor - visible/2
	if cursor < 0 || start < 0 {
		start = 0
	}
	if start > count-visible {
		start = count - visible
	}
	return start
}

// hitTable maps a mouse click to a data-row index. Screens record one during
// View() (the geometry is known there) and consult it on the next MouseMsg.
type hitTable struct {
	topY    int // absolute Y of the first visible data row
	visible int
	count   int
	minX    int
	maxX    int
}

func (h hitTable) rowAt(x, y, cursor int) int {
	if h.count == 0 || x < h.minX || x > h.maxX || y < h.topY {
		return -1
	}
	start := clampStart(cursor, h.count, h.visible)
	idx := start + (y - h.topY)
	if idx < 0 || idx >= h.count || idx >= start+h.visible {
		return -1
	}
	return idx
}

type col struct {
	title string
	w     int // 0 = size to content
}

// renderTable draws a scrollable, selectable table sized to height rows
// (including the header). cursor is the selected absolute row index; a negative
// cursor means the table is unfocused (no selection bar).
func renderTable(cols []col, rows [][]string, cursor, width, height int) string {
	if height < 2 {
		height = 2
	}
	widths := make([]int, len(cols))
	for i, c := range cols {
		widths[i] = max(c.w, lipgloss.Width(c.title))
	}
	for _, r := range rows {
		for i := range cols {
			if cols[i].w == 0 && i < len(r) && lipgloss.Width(r[i]) > widths[i] {
				widths[i] = lipgloss.Width(r[i])
			}
		}
	}
	rowW := 0
	for _, w := range widths {
		rowW += w
	}
	rowW += 2 * (len(cols) - 1)
	barW := min(rowW+2, width-2) // +2 for the caret/indent column

	var b strings.Builder
	// header (indented to clear the 2-col caret gutter)
	hdr := make([]string, len(cols))
	for i, c := range cols {
		hdr[i] = stColHdr.Render(pad(c.title, widths[i]))
	}
	b.WriteString("   " + strings.Join(hdr, "  ") + "\n")
	b.WriteString(stMuted.Render("  "+strings.Repeat("─", max(barW-2, 1))) + "\n")

	if len(rows) == 0 {
		b.WriteString(stMuted.Render("   nothing here yet"))
		return b.String()
	}

	visible := height - 2
	if visible < 1 {
		visible = 1
	}
	start := clampStart(cursor, len(rows), visible)
	end := min(start+visible, len(rows))

	for i := start; i < end; i++ {
		cells := make([]string, len(cols))
		for j := range cols {
			c := ""
			if j < len(rows[i]) {
				c = rows[i][j]
			}
			cells[j] = pad(c, widths[j])
		}
		inner := strings.Join(cells, "  ")
		var line string
		if i == cursor {
			// fit (truncate+pad) BEFORE styling: lipgloss .Width() would wrap a
			// too-wide row onto extra lines instead of clipping it.
			line = stSelBar.Render("▌") + stSelected.Render(fitLine(" "+inner, barW))
		} else {
			line = "   " + inner
		}
		b.WriteString(line)
		if i < end-1 {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// panel draws a rounded box with a plain title embedded in the top border.
func panel(title, body string, width, height int, active bool) string {
	label := ""
	if title != "" {
		ts := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colText))
		if active {
			ts = ts.Foreground(lipgloss.Color(colAccent))
		}
		label = ts.Render(title)
	}
	return panelRaw(label, body, width, height, active)
}

// panelRaw is like panel but takes an already-styled label (e.g. a tab strip),
// placing it verbatim in the top border. This is the core btop/gh-dash look.
func panelRaw(label, body string, width, height int, active bool) string {
	if width < 4 {
		width = 4
	}
	if height < 3 {
		height = 3
	}
	bc := colBorder
	if active {
		bc = colAccent
	}
	bs := lipgloss.NewStyle().Foreground(lipgloss.Color(bc))
	inner := width - 2

	var top string
	if label != "" {
		full := bs.Render("┤ ") + label + bs.Render(" ├")
		rest := inner - lipgloss.Width(full) - 1
		if rest < 0 {
			rest = 0
		}
		top = bs.Render("╭─") + full + bs.Render(strings.Repeat("─", rest)+"╮")
	} else {
		top = bs.Render("╭" + strings.Repeat("─", inner) + "╮")
	}

	contentW := inner - 2
	lines := strings.Split(body, "\n")
	bodyH := height - 2
	rows := make([]string, 0, height)
	rows = append(rows, top)
	for i := 0; i < bodyH; i++ {
		ln := ""
		if i < len(lines) {
			ln = lines[i]
		}
		rows = append(rows, bs.Render("│")+" "+fitLine(ln, contentW)+" "+bs.Render("│"))
	}
	rows = append(rows, bs.Render("╰"+strings.Repeat("─", inner)+"╯"))
	return strings.Join(rows, "\n")
}

// fitLine truncates (ANSI-aware) then right-pads a line to exactly w cells.
func fitLine(s string, w int) string {
	if w <= 0 {
		return ""
	}
	s = ansi.Truncate(s, w, "")
	if gap := w - lipgloss.Width(s); gap > 0 {
		s += strings.Repeat(" ", gap)
	}
	return s
}

// sideBySide lays out two panels horizontally.
func sideBySide(a, b string) string {
	return lipgloss.JoinHorizontal(lipgloss.Top, a, b)
}

// brailleGraph renders a time series as a multi-row braille area chart (btop
// style). Each cell packs 2×4 dots, so the effective resolution is width*2 ×
// height*4. Rows are colored on a green→yellow→red vertical gradient, so taller
// (higher-usage) spikes read as hotter.
func brailleGraph(series []float64, width, height int) string {
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	dotsW, dotsH := width*2, height*4
	samp := make([]float64, dotsW)
	if len(series) > 0 {
		for i := 0; i < dotsW; i++ {
			idx := i * len(series) / dotsW
			if idx >= len(series) {
				idx = len(series) - 1
			}
			samp[i] = series[idx]
		}
	}
	mx := 0.0
	for _, v := range samp {
		if v > mx {
			mx = v
		}
	}
	if mx <= 0 {
		mx = 1
	}

	grid := make([][]byte, height)
	for r := range grid {
		grid[r] = make([]byte, width)
	}
	leftBits := [4]byte{0x01, 0x02, 0x04, 0x40}
	rightBits := [4]byte{0x08, 0x10, 0x20, 0x80}
	for c := 0; c < dotsW; c++ {
		fill := int(samp[c]/mx*float64(dotsH) + 0.5)
		if fill > dotsH {
			fill = dotsH
		}
		for k := 0; k < fill; k++ {
			r := dotsH - 1 - k
			cellRow, sub, cellCol := r/4, r%4, c/2
			if c%2 == 0 {
				grid[cellRow][cellCol] |= leftBits[sub]
			} else {
				grid[cellRow][cellCol] |= rightBits[sub]
			}
		}
	}

	lines := make([]string, height)
	for r := 0; r < height; r++ {
		var sb strings.Builder
		for c := 0; c < width; c++ {
			sb.WriteRune(rune(0x2800 + int(grid[r][c])))
		}
		lines[r] = lipgloss.NewStyle().Foreground(lipgloss.Color(gradColor(r, height))).Render(sb.String())
	}
	return strings.Join(lines, "\n")
}

// gradColor maps a row (0=top) to the green→yellow→red gradient.
func gradColor(row, height int) string {
	frac := float64(row) / float64(max(height-1, 1))
	switch {
	case frac < 0.34:
		return colRed
	case frac < 0.67:
		return colYellow
	default:
		return colGreen
	}
}

// barMeter renders a filled/empty block bar colored by fill ratio, with a
// trailing percentage.
func barMeter(value, maxv float64, width int) string {
	if maxv <= 0 {
		maxv = 1
	}
	pct := value / maxv
	if pct > 1 {
		pct = 1
	}
	if pct < 0 {
		pct = 0
	}
	if width < 4 {
		width = 4
	}
	label := fmt.Sprintf(" %3.0f%%", pct*100)
	barW := width - lipgloss.Width(label)
	if barW < 1 {
		barW = 1
	}
	filled := int(pct*float64(barW) + 0.5)
	c := colGreen
	switch {
	case pct >= 0.85:
		c = colRed
	case pct >= 0.6:
		c = colYellow
	}
	bar := lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render(strings.Repeat("█", filled)) +
		stMuted.Render(strings.Repeat("░", barW-filled))
	return bar + stMuted.Render(label)
}

func pad(s string, w int) string {
	d := w - lipgloss.Width(s)
	if d <= 0 {
		return s
	}
	return s + strings.Repeat(" ", d)
}

func fmtCPU(milli float64) string {
	if milli >= 1000 {
		return fmt.Sprintf("%.2f cores", milli/1000)
	}
	return fmt.Sprintf("%.0fm", milli)
}

func fmtBytes(b float64) string {
	const u = 1024
	if b < u {
		return fmt.Sprintf("%.0f B", b)
	}
	exp, n := 0, b
	for n >= u && exp < 4 {
		n /= u
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", n, "KMGT"[exp-1])
}
