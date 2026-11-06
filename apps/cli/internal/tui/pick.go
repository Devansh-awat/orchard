package tui

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hackclub/orchard/cli/internal/output"
)

type PickOption struct {
	Group  string
	Label  string
	Detail string
}

type pickModel struct {
	title    string
	opts     []PickOption
	selected []bool
	cursor   int
	height   int
	done     bool
	aborted  bool
}

func newPickModel(title string, opts []PickOption) pickModel {
	sel := make([]bool, len(opts))
	for i := range sel {
		sel[i] = true
	}
	return pickModel{title: title, opts: opts, selected: sel}
}

func (m pickModel) Init() tea.Cmd { return nil }

func (m pickModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.height = msg.Height
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor < len(m.opts)-1 {
				m.cursor++
			}
		case "home", "g":
			m.cursor = 0
		case "end", "G":
			m.cursor = len(m.opts) - 1
		case " ", "x":
			if len(m.opts) > 0 {
				m.selected[m.cursor] = !m.selected[m.cursor]
			}
		case "a":
			all := m.count() == len(m.opts)
			for i := range m.selected {
				m.selected[i] = !all
			}
		case "enter":
			m.done = true
			return m, tea.Quit
		case "q", "esc", "ctrl+c":
			m.aborted = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m pickModel) count() int {
	n := 0
	for _, s := range m.selected {
		if s {
			n++
		}
	}
	return n
}

func (m pickModel) View() string { return output.SanitizeView(m.view()) }

func (m pickModel) view() string {
	if m.done || m.aborted {
		return ""
	}
	lines := []string{}
	cursorLine := 0
	group := ""
	for i, o := range m.opts {
		if i == 0 || o.Group != group {
			group = o.Group
			lines = append(lines, stColHdr.Render(group))
		}
		box := stMuted.Render("[ ]")
		if m.selected[i] {
			box = stGreen.Render("[x]")
		}
		label := o.Label
		bar := "  "
		if i == m.cursor {
			cursorLine = len(lines)
			bar = stSelBar.Render("▌ ")
			label = stTitle.Render(label)
		}
		line := bar + box + " " + label
		if o.Detail != "" {
			line += "  " + stMuted.Render(o.Detail)
		}
		lines = append(lines, line)
	}
	if room := m.height - 5; room > 0 && len(lines) > room {
		start := min(max(cursorLine-room/2, 0), len(lines)-room)
		lines = lines[start : start+room]
	}
	var b strings.Builder
	b.WriteString(stAccent.Render(m.title) + "\n\n")
	b.WriteString(strings.Join(lines, "\n") + "\n\n")
	b.WriteString(stFooter.Render(fmt.Sprintf("%d of %d selected", m.count(), len(m.opts))) + "  ")
	b.WriteString(stKey.Render("space") + stMuted.Render(" toggle  ") + stKey.Render("a") + stMuted.Render(" all  ") + stKey.Render("enter") + stMuted.Render(" confirm  ") + stKey.Render("q") + stMuted.Render(" cancel") + "\n")
	return b.String()
}

func (m pickModel) picked() []int {
	out := []int{}
	for i, s := range m.selected {
		if s {
			out = append(out, i)
		}
	}
	return out
}

func PickMany(title string, opts []PickOption) ([]int, bool, error) {
	final, err := tea.NewProgram(newPickModel(title, opts), tea.WithOutput(os.Stderr)).Run()
	if err != nil {
		return nil, false, err
	}
	m := final.(pickModel)
	if m.aborted {
		return nil, false, nil
	}
	return m.picked(), true, nil
}
