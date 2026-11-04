package tui

import (
	"context"
	"net/url"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/api"
)

// keyGrabber marks screens whose focused text inputs or active modals must
// receive raw keys before any global shortcut ('o', '/', ctrl+k) fires.
type keyGrabber interface{ grabsKeys() bool }

func grabsKeys(s screen) bool {
	if g, ok := s.(keyGrabber); ok {
		return g.grabsKeys()
	}
	return false
}

// Screens that capture typed text (or run a modal) opt out of global keys.
// Declared here, next to the overlays that depend on them, so the ownership of
// the global-shortcut behavior lives in one file.
func (s *formScreen) grabsKeys() bool       { return true }
func (s *projectForm) grabsKeys() bool      { return true }
func (s *envScreen) grabsKeys() bool        { return true }
func (s *deploymentScreen) grabsKeys() bool { return s.confirm.Active() }
func (s *switcherScreen) grabsKeys() bool   { return true }

// orgSelectedMsg asks the root to switch the whole app to another org:
// collapse to a fresh projects list and re-point the event bus (see app.go).
type orgSelectedMsg struct{ org Org }

// stackProject finds the project context of the current navigation stack, so
// the switcher can offer that project's environments next to the org list.
func stackProject(stack []screen) *Project {
	for i := len(stack) - 1; i >= 0; i-- {
		switch v := stack[i].(type) {
		case *projectScreen:
			if v.project.ID != "" {
				p := v.project
				return &p
			}
		case *deploymentScreen:
			if v.project.ID != "" {
				p := v.project
				return &p
			}
		}
	}
	return nil
}

type projectEnv struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Slug      string `json:"slug"`
	IsDefault bool   `json:"isDefault"`
}

type switcherEnvsMsg struct {
	items []projectEnv
	err   error
}

func fetchProjectEnvs(cl *api.Client, projectID string) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[projectEnv](cl, "/projects/"+url.PathEscape(projectID)+"/environments")
		return switcherEnvsMsg{items, err}
	}
}

// setDefaultEnv mirrors `orchard env set-default`.
func setDefaultEnv(cl *api.Client, env projectEnv) tea.Cmd {
	return func() tea.Msg {
		err := cl.Send(context.Background(), "POST", "/environments/"+url.PathEscape(env.ID)+"/set-default", nil, nil)
		return actionMsg{"default environment: " + env.Name, err}
	}
}

const (
	switcherOrgs = iota
	switcherEnvs
)

// switcherScreen is the 'o' overlay: pick an org to re-scope the whole app,
// or (when opened with a project context) manage that project's environments.
type switcherScreen struct {
	cl      *api.Client
	curOrg  string   // active org id, for the ● current marker
	project *Project // non-nil → env mode available on tab
	mode    int
	orgs    []Org
	envs    []projectEnv
	oCursor int
	eCursor int
	loading bool
	err     error
	w, h    int
}

func newSwitcherScreen(cl *api.Client, curOrgID string, project *Project) *switcherScreen {
	return &switcherScreen{cl: cl, curOrg: curOrgID, project: project, loading: true}
}

func (s *switcherScreen) title() string { return "Switch" }

func (s *switcherScreen) Init() tea.Cmd {
	cmds := []tea.Cmd{fetchOrgs(s.cl)}
	if s.project != nil {
		cmds = append(cmds, fetchProjectEnvs(s.cl, s.project.ID))
	}
	return tea.Batch(cmds...)
}

func (s *switcherScreen) help() []keyHint {
	h := []keyHint{{"↑/↓", "move"}}
	if s.mode == switcherOrgs {
		h = append(h, keyHint{"enter", "switch organization"}, keyHint{"s", "organization settings"})
	} else {
		h = append(h, keyHint{"enter", "set default"})
	}
	if s.project != nil {
		h = append(h, keyHint{"tab", "orgs/envs"})
	}
	return append(h, keyHint{"esc", "close"})
}

func (s *switcherScreen) count() int {
	if s.mode == switcherEnvs {
		return len(s.envs)
	}
	return len(s.orgs)
}

func (s *switcherScreen) cursor() *int {
	if s.mode == switcherEnvs {
		return &s.eCursor
	}
	return &s.oCursor
}

func (s *switcherScreen) move(d int) {
	c := s.cursor()
	n := s.count()
	if n == 0 {
		return
	}
	*c += d
	if *c < 0 {
		*c = 0
	}
	if *c >= n {
		*c = n - 1
	}
}

func (s *switcherScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case orgsMsg:
		s.loading = false
		s.orgs, s.err = msg.items, msg.err
		if s.oCursor >= len(s.orgs) {
			s.oCursor = 0
		}
		// start on the active org so enter is a no-op-ish default
		for i, o := range s.orgs {
			if o.ID == s.curOrg {
				s.oCursor = i
				break
			}
		}
	case switcherEnvsMsg:
		s.envs = msg.items
		if msg.err != nil && s.err == nil {
			s.err = msg.err
		}
		if s.eCursor >= len(s.envs) {
			s.eCursor = 0
		}
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		cmds := []tea.Cmd{flashf("%s", msg.text)}
		if s.project != nil {
			cmds = append(cmds, fetchProjectEnvs(s.cl, s.project.ID))
		}
		return s, tea.Batch(cmds...)
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			s.move(-1)
		case tea.MouseButtonWheelDown:
			s.move(1)
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc", "q":
			return s, pop
		case "up", "k":
			s.move(-1)
		case "down", "j":
			s.move(1)
		case "tab":
			if s.project != nil {
				s.mode = 1 - s.mode
			}
		case "s":
			if s.mode == switcherOrgs && s.oCursor < len(s.orgs) {
				return s, push(newOrgSettingsScreen(s.cl, s.orgs[s.oCursor].ID))
			}
		case "enter":
			if s.mode == switcherOrgs && s.oCursor < len(s.orgs) {
				org := s.orgs[s.oCursor]
				return s, func() tea.Msg { return orgSelectedMsg{org} }
			}
			if s.mode == switcherEnvs && s.eCursor < len(s.envs) {
				env := s.envs[s.eCursor]
				if env.IsDefault {
					return s, flashf("%s is already the default environment", env.Name)
				}
				return s, setDefaultEnv(s.cl, env)
			}
		}
	}
	return s, nil
}

func (s *switcherScreen) View() string {
	boxW := min(max(s.w-20, 40), 64)
	var b strings.Builder

	switch {
	case s.loading:
		b.WriteString(stMuted.Render("loading organizations…"))
	case s.err != nil:
		b.WriteString(stRed.Render("✗ " + s.err.Error()))
	case s.mode == switcherOrgs:
		s.renderRows(&b, len(s.orgs), s.oCursor, func(i int) (string, string, string) {
			o := s.orgs[i]
			mark := ""
			if o.ID == s.curOrg {
				mark = stGreen.Render("● current")
			}
			return o.Name, o.Slug, mark
		})
	default:
		s.renderRows(&b, len(s.envs), s.eCursor, func(i int) (string, string, string) {
			e := s.envs[i]
			mark := ""
			if e.IsDefault {
				mark = stGreen.Render("● default")
			}
			return e.Name, e.Slug, mark
		})
	}

	title := "Switch organization"
	if s.mode == switcherEnvs && s.project != nil {
		title = "Environments: " + s.project.Name
	}
	if s.project != nil {
		title += stMuted.Render("  (tab to flip)")
	}
	rows := strings.Count(b.String(), "\n") + 3
	box := panel(title, b.String(), boxW, max(rows, 5), true)
	return lipgloss.Place(s.w, max(s.h-chromeH, 1), lipgloss.Center, lipgloss.Center, box)
}

func (s *switcherScreen) renderRows(b *strings.Builder, n, cursor int, row func(int) (name, sub, mark string)) {
	if n == 0 {
		b.WriteString(stMuted.Render("nothing here yet"))
		return
	}
	// name+sub occupy a fixed 38 cells so the current/default mark always fits
	// inside the panel's content width regardless of the terminal size.
	for i := 0; i < n; i++ {
		name, sub, mark := row(i)
		if i == cursor {
			b.WriteString(stSelBar.Render("▌") + stSelected.Render(fitLine(" "+pad(name, 22)+" "+pad(sub, 14), 38)) + " " + mark)
		} else {
			b.WriteString("  " + pad(name, 22) + " " + stMuted.Render(pad(sub, 14)) + " " + mark)
		}
		if i < n-1 {
			b.WriteString("\n")
		}
	}
}
