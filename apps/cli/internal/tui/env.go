package tui

import (
	"context"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type envSavedMsg struct{}

type envScreen struct {
	cl      *api.Client
	id      string
	ta      textarea.Model
	errText string
	busy    bool
	w, h    int
}

func newEnvScreen(cl *api.Client, id string, vars []EnvVar) *envScreen {
	ta := textarea.New()
	ta.Placeholder = "KEY=value"
	ta.ShowLineNumbers = true
	ta.Prompt = stMuted.Render("│ ")
	ta.CharLimit = 0

	// Strip the textarea's own chrome so it sits cleanly inside our panel:
	// no full-width cursor-line highlight, themed line numbers/text.
	blank := lipgloss.NewStyle()
	ta.FocusedStyle.Base = blank
	ta.FocusedStyle.CursorLine = blank
	ta.FocusedStyle.EndOfBuffer = stMuted
	ta.FocusedStyle.LineNumber = stMuted
	ta.FocusedStyle.CursorLineNumber = stKey
	ta.FocusedStyle.Text = stInputOn
	ta.FocusedStyle.Placeholder = stMuted
	ta.BlurredStyle.Base = blank
	ta.BlurredStyle.CursorLine = blank

	lines := make([]string, 0, len(vars))
	for _, e := range vars {
		lines = append(lines, e.Key+"="+e.Value)
	}
	ta.SetValue(strings.Join(lines, "\n"))
	ta.Focus()
	return &envScreen{cl: cl, id: id, ta: ta}
}

func (s *envScreen) title() string { return "Edit env" }

func (s *envScreen) help() []keyHint { return []keyHint{{"ctrl+s", "save"}, {"esc", "cancel"}} }

func (s *envScreen) Init() tea.Cmd { return textarea.Blink }

func (s *envScreen) submit() (screen, tea.Cmd) {
	vars := parseEnv(s.ta.Value())
	s.busy, s.errText = true, ""
	id := s.id
	cl := s.cl
	return s, func() tea.Msg {
		err := cl.Send(context.Background(), "PUT", "/deployments/"+id+"/env", map[string]any{"env": vars}, nil)
		return formResult{ok: envSavedMsg{}, err: err}
	}
}

func (s *envScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
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

func (s *envScreen) View() string {
	var b strings.Builder
	b.WriteString(stMuted.Render("one KEY=value per line · saving replaces all variables and redeploys") + "\n\n")
	b.WriteString(s.ta.View())
	if s.errText != "" {
		b.WriteString("\n\n" + stRed.Render("✗ "+s.errText))
	} else if s.busy {
		b.WriteString("\n\n" + stYellow.Render("saving…"))
	}
	return panelRaw(stTabSel.Render("Environment"), b.String(), s.w, s.h-chromeH, true)
}

func parseEnv(s string) []EnvVar {
	var out []EnvVar
	for _, ln := range strings.Split(s, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" || strings.HasPrefix(ln, "#") {
			continue
		}
		i := strings.Index(ln, "=")
		if i < 0 {
			continue
		}
		k := strings.TrimSpace(ln[:i])
		v := strings.TrimSpace(ln[i+1:])
		if k == "" {
			continue
		}
		out = append(out, EnvVar{Key: k, Value: v})
	}
	return out
}
