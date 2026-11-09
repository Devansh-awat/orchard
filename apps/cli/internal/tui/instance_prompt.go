package tui

import (
	"context"
	"os"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/hackclub/orchard/cli/internal/output"
)

type InstanceCheck func(ctx context.Context, raw string) (string, error)

type instanceCheckedMsg struct {
	url string
	err error
}

type instancePromptModel struct {
	input    textinput.Model
	check    InstanceCheck
	ctx      context.Context
	cancel   context.CancelFunc
	checking bool
	problem  string
	url      string
	done     bool
	aborted  bool
}

func newInstancePrompt(ctx context.Context, check InstanceCheck) instancePromptModel {
	ti := formTI("https://orchard.example.com")
	ti.Prompt = "› "
	ti.CharLimit = 2048
	ti.Focus()
	ctx, cancel := context.WithCancel(ctx)
	return instancePromptModel{input: ti, check: check, ctx: ctx, cancel: cancel}
}

func (m instancePromptModel) Init() tea.Cmd { return textinput.Blink }

func (m instancePromptModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case instanceCheckedMsg:
		m.checking = false
		if msg.err != nil {
			if m.aborted {
				return m, nil
			}
			m.problem = msg.err.Error()
			return m, textinput.Blink
		}
		m.url, m.done = msg.url, true
		m.cancel()
		return m, tea.Quit
	case tea.KeyMsg:
		switch msg.String() {
		case "esc", "ctrl+c":
			m.aborted = true
			m.cancel()
			return m, tea.Quit
		case "enter":
			if m.checking {
				return m, nil
			}
			m.checking, m.problem = true, ""
			ctx, check, raw := m.ctx, m.check, m.input.Value()
			return m, func() tea.Msg {
				url, err := check(ctx, raw)
				return instanceCheckedMsg{url: url, err: err}
			}
		}
		if m.checking {
			return m, nil
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m instancePromptModel) View() string { return output.SanitizeView(m.view()) }

func (m instancePromptModel) view() string {
	if m.done || m.aborted {
		return ""
	}
	var b strings.Builder
	b.WriteString(stAccent.Render("Connect to your Orchard instance") + "\n\n")
	b.WriteString(stMuted.Render("Enter the URL you use to open Orchard.") + "\n\n")
	b.WriteString(m.input.View() + "\n\n")
	switch {
	case m.checking:
		b.WriteString(stMuted.Render("checking…") + "\n\n")
	case m.problem != "":
		b.WriteString(stRed.Render("✗ "+m.problem) + "\n\n")
	}
	b.WriteString(stKey.Render("enter") + stMuted.Render(" continue  ") + stKey.Render("esc") + stMuted.Render(" cancel") + "\n")
	return b.String()
}

func AskInstanceURL(ctx context.Context, check InstanceCheck) (string, bool, error) {
	m := newInstancePrompt(ctx, check)
	defer m.cancel()
	final, err := tea.NewProgram(m, tea.WithOutput(os.Stderr), tea.WithContext(ctx)).Run()
	if err != nil {
		return "", false, err
	}
	res := final.(instancePromptModel)
	if !res.done {
		return "", false, nil
	}
	return res.url, true, nil
}
