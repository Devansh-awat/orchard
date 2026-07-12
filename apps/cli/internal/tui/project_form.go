package tui

import (
	"context"
	"strings"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type projectCreatedMsg struct{ name string }
type orgsMsg struct {
	items []Org
	err   error
}

func fetchOrgs(cl *api.Client) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Org](cl, "/organizations/user")
		return orgsMsg{items, err}
	}
}

// projectForm has an org cycler plus a name/description, so it can't reuse the
// plain text formScreen.
type projectForm struct {
	cl      *api.Client
	orgs    []Org
	orgIdx  int
	name    textinput.Model
	desc    textinput.Model
	focus   int // 0 org, 1 name, 2 desc
	errText string
	busy    bool
	loading bool
	w, h    int
}

func newProjectFormScreen(cl *api.Client) *projectForm {
	name := textinput.New()
	name.Placeholder = "my-project"
	name.Prompt = ""
	desc := textinput.New()
	desc.Placeholder = "optional description"
	desc.Prompt = ""
	return &projectForm{cl: cl, name: name, desc: desc, focus: 1, loading: true}
}

func (s *projectForm) title() string { return "New project" }

func (s *projectForm) help() []keyHint {
	return []keyHint{{"←/→", "org"}, {"enter", "next"}, {"ctrl+s", "create"}, {"esc", "cancel"}}
}

func (s *projectForm) Init() tea.Cmd { return tea.Batch(fetchOrgs(s.cl), textinput.Blink) }

func (s *projectForm) refocus() {
	s.name.Blur()
	s.desc.Blur()
	switch s.focus {
	case 1:
		s.name.Focus()
	case 2:
		s.desc.Focus()
	}
}

func (s *projectForm) submit() (screen, tea.Cmd) {
	if len(s.orgs) == 0 {
		s.errText = "no organizations available"
		return s, nil
	}
	if strings.TrimSpace(s.name.Value()) == "" {
		s.errText = "name is required"
		return s, nil
	}
	s.busy, s.errText = true, ""
	org := s.orgs[s.orgIdx]
	name := strings.TrimSpace(s.name.Value())
	desc := strings.TrimSpace(s.desc.Value())
	return s, func() tea.Msg {
		body := map[string]any{"organizationId": org.ID, "name": name}
		if desc != "" {
			body["description"] = desc
		}
		err := cl_send(s.cl, "POST", "/projects", body)
		return formResult{ok: projectCreatedMsg{name}, err: err}
	}
}

func (s *projectForm) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case orgsMsg:
		s.loading = false
		s.orgs = msg.items
		if msg.err != nil {
			s.errText = msg.err.Error()
		}
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
		case "tab", "down":
			s.focus = (s.focus + 1) % 3
			s.refocus()
			return s, nil
		case "shift+tab", "up":
			s.focus = (s.focus + 2) % 3
			s.refocus()
			return s, nil
		case "left":
			if s.focus == 0 && len(s.orgs) > 0 {
				s.orgIdx = (s.orgIdx - 1 + len(s.orgs)) % len(s.orgs)
			}
			return s, nil
		case "right":
			if s.focus == 0 && len(s.orgs) > 0 {
				s.orgIdx = (s.orgIdx + 1) % len(s.orgs)
			}
			return s, nil
		case "ctrl+s":
			return s.submit()
		case "enter":
			if s.focus == 2 {
				return s.submit()
			}
			s.focus++
			s.refocus()
			return s, nil
		}
	}
	var cmd tea.Cmd
	if s.focus == 1 {
		s.name, cmd = s.name.Update(msg)
	} else if s.focus == 2 {
		s.desc, cmd = s.desc.Update(msg)
	}
	return s, cmd
}

func (s *projectForm) View() string {
	if s.loading {
		return stMuted.Render("\n  loading organizations…")
	}
	var b strings.Builder
	b.WriteString("\n  " + stTitle.Render("New project") + "\n\n")

	orgLabel := stMuted.Render("Organization")
	if s.focus == 0 {
		orgLabel = stAccent.Render("Organization")
	}
	orgName := "(none)"
	if len(s.orgs) > 0 {
		orgName = s.orgs[s.orgIdx].Name
	}
	picker := stMuted.Render("‹ ") + stInputOn.Render(orgName) + stMuted.Render(" ›")
	if len(s.orgs) > 1 {
		picker += stMuted.Render("   (←/→ to change)")
	}
	b.WriteString("  " + orgLabel + "\n  " + picker + "\n\n")

	nameLabel := stMuted.Render("Name")
	if s.focus == 1 {
		nameLabel = stAccent.Render("Name")
	}
	b.WriteString("  " + nameLabel + "\n" + boxedInput(s.name.View(), s.focus == 1, s.w) + "\n\n")

	descLabel := stMuted.Render("Description")
	if s.focus == 2 {
		descLabel = stAccent.Render("Description")
	}
	b.WriteString("  " + descLabel + "\n" + boxedInput(s.desc.View(), s.focus == 2, s.w) + "\n\n")

	if s.errText != "" {
		b.WriteString("  " + stRed.Render("✗ "+s.errText) + "\n")
	}
	status := "enter next · ctrl+s create · esc cancel"
	if s.busy {
		status = "creating…"
	}
	b.WriteString("\n  " + stFooter.Render(status))
	return b.String()
}

// ---- deploy type menu ----

type deployMenu struct {
	cl      *api.Client
	project Project
	cursor  int
}

func newDeployMenuScreen(cl *api.Client, p Project) *deployMenu {
	return &deployMenu{cl: cl, project: p}
}

func (s *deployMenu) title() string { return "New deployment" }
func (s *deployMenu) Init() tea.Cmd { return nil }
func (s *deployMenu) help() []keyHint {
	return []keyHint{{"↑/↓", "choose"}, {"enter", "select"}, {"esc", "cancel"}}
}

func (s *deployMenu) Update(msg tea.Msg) (screen, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "esc":
			return s, pop
		case "up", "k":
			s.cursor = 0
		case "down", "j":
			s.cursor = 1
		case "enter":
			if s.cursor == 0 {
				return s, replace(newDeployFormGithub(s.cl, s.project))
			}
			return s, replace(newDeployFormImage(s.cl, s.project))
		}
	}
	return s, nil
}

func (s *deployMenu) View() string {
	opts := []struct{ name, desc string }{
		{"From GitHub", "Build and deploy a repo (Dockerfile / Railpack)"},
		{"From image", "Run an existing container image"},
	}
	var b strings.Builder
	b.WriteString("\n  " + stTitle.Render("How do you want to deploy?") + "\n\n")
	for i, o := range opts {
		line := "  " + stTitle.Render(o.name) + "  " + stMuted.Render(o.desc)
		if i == s.cursor {
			line = stSelected.Render("▶ " + o.name + "  " + o.desc)
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n  " + stFooter.Render("↑/↓ choose · enter select · esc cancel"))
	return b.String()
}

func boxedInput(view string, focused bool, w int) string {
	box := boxStyle(w)
	if focused {
		box = box.BorderForeground(lipgloss.Color(colAccent))
	}
	return box.Render(view)
}

func cl_send(cl *api.Client, method, path string, body any) error {
	return cl.Send(context.Background(), method, path, body, nil)
}
