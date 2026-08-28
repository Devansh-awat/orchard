package tui

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---- backup schedule editor ----

// dbSchedulePresets mirror the frontend SCHEDULE_PRESETS (all cron in UTC).
var dbSchedulePresets = []struct{ label, cron string }{
	{"Every hour", "0 * * * *"},
	{"Every 6 hours", "0 */6 * * *"},
	{"Daily at 02:00 UTC", "0 2 * * *"},
	{"Weekly (Sun 02:00 UTC)", "0 2 * * 0"},
}

var (
	dbSchedCustom = len(dbSchedulePresets)     // "Custom cron…" row
	dbSchedNone   = len(dbSchedulePresets) + 1 // "None (disable)" row
)

type dbScheduleScreen struct {
	cl      *api.Client
	id      string
	cursor  int
	cron    textinput.Model
	errText string
	busy    bool
	w, h    int
}

func newDBScheduleScreen(cl *api.Client, id, current string) *dbScheduleScreen {
	ti := textinput.New()
	ti.Placeholder = "*/30 * * * *"
	ti.Prompt = ""
	ti.CharLimit = 64
	s := &dbScheduleScreen{cl: cl, id: id, cron: ti}
	switch current {
	case "":
		s.cursor = dbSchedNone
	default:
		s.cursor = dbSchedCustom
		s.cron.SetValue(current)
		for i, p := range dbSchedulePresets {
			if p.cron == current {
				s.cursor = i
				s.cron.SetValue("")
				break
			}
		}
	}
	s.refocus()
	return s
}

func (s *dbScheduleScreen) title() string { return "Backup schedule" }

func (s *dbScheduleScreen) help() []keyHint {
	return []keyHint{{"↑/↓", "choose"}, {"enter", "save"}, {"esc", "cancel"}}
}

func (s *dbScheduleScreen) Init() tea.Cmd { return textinput.Blink }

func (s *dbScheduleScreen) refocus() {
	if s.cursor == dbSchedCustom {
		s.cron.Focus()
	} else {
		s.cron.Blur()
	}
}

func (s *dbScheduleScreen) submit() (screen, tea.Cmd) {
	cl, id := s.cl, s.id
	if s.cursor == dbSchedNone {
		s.busy, s.errText = true, ""
		return s, func() tea.Msg {
			err := cl.Send(context.Background(), "DELETE", dbPath(id)+"/backup-schedule", nil, nil)
			return formResult{ok: dbChangedMsg{"backup schedule cleared"}, err: err}
		}
	}
	expr := ""
	if s.cursor == dbSchedCustom {
		expr = strings.TrimSpace(s.cron.Value())
		if expr == "" {
			s.errText = "cron expression is required"
			return s, nil
		}
	} else {
		expr = dbSchedulePresets[s.cursor].cron
	}
	s.busy, s.errText = true, ""
	return s, func() tea.Msg {
		err := cl.Send(context.Background(), "PUT", dbPath(id)+"/backup-schedule", map[string]any{"cron": expr}, nil)
		return formResult{ok: dbChangedMsg{fmt.Sprintf("backup schedule set to %q (UTC)", expr)}, err: err}
	}
}

func (s *dbScheduleScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case formResult:
		s.busy = false
		if msg.err != nil {
			s.errText = msg.err.Error()
			return s, nil
		}
		return s, finishForm(msg.ok)
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "up", "shift+tab":
			if s.cursor > 0 {
				s.cursor--
				s.refocus()
			}
			return s, nil
		case "down", "tab":
			if s.cursor < dbSchedNone {
				s.cursor++
				s.refocus()
			}
			return s, nil
		case "enter", "ctrl+s":
			return s.submit()
		}
	}
	var cmd tea.Cmd
	if s.cursor == dbSchedCustom {
		s.cron, cmd = s.cron.Update(msg)
	}
	return s, cmd
}

func (s *dbScheduleScreen) View() string {
	var b strings.Builder
	b.WriteString("\n  " + stTitle.Render("Automated backup schedule") + "\n\n")
	line := func(i int, label, note string) {
		if i == s.cursor {
			b.WriteString(stSelected.Render("▶ "+label) + "  " + stMuted.Render(note) + "\n")
		} else {
			b.WriteString("  " + label + "  " + stMuted.Render(note) + "\n")
		}
	}
	for i, p := range dbSchedulePresets {
		line(i, p.label, p.cron)
	}
	line(dbSchedCustom, "Custom cron…", "5-field cron, UTC")
	if s.cursor == dbSchedCustom {
		b.WriteString(boxedInput(s.cron.View(), true, s.w) + "\n")
	}
	line(dbSchedNone, "None", "disable automated backups (existing backups are kept)")
	if s.errText != "" {
		b.WriteString("\n  " + stRed.Render("✗ "+s.errText) + "\n")
	}
	status := "↑/↓ choose · enter save · esc cancel"
	if s.busy {
		status = "saving…"
	}
	b.WriteString("\n  " + stFooter.Render(status))
	return b.String()
}

// ---- extension install ----

func newDBExtInstallScreen(cl *api.Client, id string) *formScreen {
	return newForm("Install extension",
		"Preloading adds to shared_preload_libraries and restarts the database.",
		[]*field{
			fld("name", "Name", "pg_stat_statements", true),
			fld("preload", "Preload (y/N)", "n", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"name": v["name"]}
				if strings.HasPrefix(strings.ToLower(v["preload"]), "y") {
					body["addToPreload"] = true
				}
				err := cl.Send(context.Background(), "POST", dbPath(id)+"/extensions", body, nil)
				return formResult{ok: dbChangedMsg{"installed extension " + v["name"]}, err: err}
			}
		})
}

// ---- cpu/memory resources ----

func newDBResourcesScreen(cl *api.Client, id string, d *dbDetail) *formScreen {
	cpuF := fld("cpu", "CPU request (millicores, empty = default)", "500", false)
	if d.CPURequestMilli > 0 {
		cpuF.ti.SetValue(strconv.Itoa(int(d.CPURequestMilli)))
	}
	memF := fld("memory", "Memory request (e.g. 512Mi, empty = default)", "512Mi", false)
	if d.MemoryRequestB > 0 {
		memF.ti.SetValue(dbFmtMemQty(int64(d.MemoryRequestB)))
	}
	return newForm("Database resources",
		"Updating requests restarts the database pod.",
		[]*field{cpuF, memF},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{}
				if v["cpu"] == "" {
					body["cpuRequestMilli"] = nil
				} else {
					n, err := strconv.Atoi(v["cpu"])
					if err != nil || n <= 0 {
						return formResult{err: errInvalid("cpu must be a positive integer (millicores)")}
					}
					body["cpuRequestMilli"] = n
				}
				if v["memory"] == "" {
					body["memoryRequestBytes"] = nil
				} else {
					bts, err := dbParseMemQty(v["memory"])
					if err != nil {
						return formResult{err: err}
					}
					body["memoryRequestBytes"] = bts
				}
				err := cl.Send(context.Background(), "PATCH", dbPath(id)+"/resources", body, nil)
				return formResult{ok: dbChangedMsg{"resources updated — pod restarting"}, err: err}
			}
		})
}

// ---- storage expansion ----

func newDBStorageScreen(cl *api.Client, id, current string) *formScreen {
	hint := "The volume can only grow, never shrink."
	if current != "" {
		hint = "Current size: " + current + " · the volume can only grow, never shrink."
	}
	return newForm("Expand storage", hint,
		[]*field{fld("size", "New size", "10Gi", true)},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				err := cl.Send(context.Background(), "PATCH", dbPath(id)+"/storage", map[string]any{"storageSize": v["size"]}, nil)
				return formResult{ok: dbChangedMsg{"storage expansion to " + v["size"] + " started"}, err: err}
			}
		})
}

// ---- postgres parameters editor ----

// dbSettingsScreen edits the full PostgreSQL parameter map as key=value lines.
// It is prefilled with the current parameters and the PATCH replaces the whole
// map server-side, so saving is the same read-modify-write as
// `orchard db settings set` (remove a line to drop a parameter).
type dbSettingsScreen struct {
	cl      *api.Client
	id      string
	ta      textarea.Model
	errText string
	busy    bool
	w, h    int
}

func newDBSettingsScreen(cl *api.Client, id string, params map[string]string) *dbSettingsScreen {
	ta := newKVTextarea()
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+params[k])
	}
	ta.SetValue(strings.Join(lines, "\n"))
	ta.Focus()
	return &dbSettingsScreen{cl: cl, id: id, ta: ta}
}

func (s *dbSettingsScreen) title() string { return "Postgres parameters" }

func (s *dbSettingsScreen) help() []keyHint {
	return []keyHint{{"ctrl+s", "save"}, {"esc", "cancel"}}
}

func (s *dbSettingsScreen) Init() tea.Cmd { return textarea.Blink }

func (s *dbSettingsScreen) submit() (screen, tea.Cmd) {
	params := map[string]string{}
	for _, kv := range parseEnv(s.ta.Value()) {
		params[kv.Key] = kv.Value
	}
	s.busy, s.errText = true, ""
	cl, id := s.cl, s.id
	return s, func() tea.Msg {
		body := map[string]any{"parameters": params}
		err := cl.Send(context.Background(), "PATCH", dbPath(id)+"/settings", body, nil)
		return formResult{ok: dbChangedMsg{fmt.Sprintf("updated %d parameter(s)", len(params))}, err: err}
	}
}

func (s *dbSettingsScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.ta.SetWidth(s.w - 6)
		s.ta.SetHeight(s.h - chromeH - 5)
	case formResult:
		s.busy = false
		if msg.err != nil {
			s.errText = msg.err.Error()
			return s, nil
		}
		return s, finishForm(msg.ok)
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "ctrl+s":
			return s.submit()
		}
	}
	var cmd tea.Cmd
	s.ta, cmd = s.ta.Update(msg)
	return s, cmd
}

func (s *dbSettingsScreen) View() string {
	var b strings.Builder
	b.WriteString(stMuted.Render("one parameter=value per line · saving replaces all parameters · some require a restart") + "\n\n")
	b.WriteString(s.ta.View())
	if s.errText != "" {
		b.WriteString("\n\n" + stRed.Render("✗ "+s.errText))
	} else if s.busy {
		b.WriteString("\n\n" + stYellow.Render("saving…"))
	}
	return panelRaw(stTabSel.Render("Postgres parameters"), b.String(), s.w, s.h-chromeH, true)
}

// newKVTextarea builds a textarea themed like the env editor (no cursor-line
// highlight, muted line numbers) for key=value editing.
func newKVTextarea() textarea.Model {
	ta := textarea.New()
	ta.Placeholder = "key=value"
	ta.ShowLineNumbers = true
	ta.Prompt = stMuted.Render("│ ")
	ta.CharLimit = 0
	blank := lipgloss.NewStyle()
	ta.FocusedStyle.Base = blank
	ta.FocusedStyle.CursorLine = blank
	ta.BlurredStyle.Base = blank
	ta.BlurredStyle.CursorLine = blank
	ta.FocusedStyle.EndOfBuffer = stMuted
	ta.FocusedStyle.LineNumber = stMuted
	ta.FocusedStyle.CursorLineNumber = stKey
	ta.FocusedStyle.Text = stInputOn
	ta.FocusedStyle.Placeholder = stMuted
	return ta
}

// dbFmtMemQty renders bytes with the largest exact binary suffix, matching
// what the resources PATCH accepts back.
func dbFmtMemQty(b int64) string {
	for _, u := range []struct {
		suffix string
		mult   int64
	}{{"Gi", 1 << 30}, {"Mi", 1 << 20}, {"Ki", 1 << 10}} {
		if b >= u.mult && b%u.mult == 0 {
			return strconv.FormatInt(b/u.mult, 10) + u.suffix
		}
	}
	return strconv.FormatInt(b, 10)
}

// dbParseMemQty accepts plain bytes or binary-suffixed quantities, the same
// grammar as `orchard db resources set --memory`.
func dbParseMemQty(s string) (int64, error) {
	for suffix, mult := range map[string]int64{"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40} {
		if v, ok := strings.CutSuffix(s, suffix); ok {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n <= 0 {
				return 0, errInvalid(fmt.Sprintf("invalid memory quantity %q", s))
			}
			return n * mult, nil
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, errInvalid(fmt.Sprintf("invalid memory quantity %q (want bytes or Ki/Mi/Gi/Ti)", s))
	}
	return n, nil
}
