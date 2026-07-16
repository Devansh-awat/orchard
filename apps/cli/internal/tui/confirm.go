package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// confirmModel is a reusable yes/no modal any screen can embed for destructive
// actions. Typical wiring:
//
//	s.confirm.Show("Delete thing X?", deleteCmd)      // on the trigger key
//	if h, cmd := s.confirm.Update(msg); h { ... }     // first thing in Update
//	return s.confirm.Overlay(body, s.w, s.h-chromeH)  // last thing in View
//	if s.confirm.Active() { return s.confirm.help() } // in help()
type confirmModel struct {
	question string
	onYes    tea.Cmd
	active   bool
}

// Show arms the modal; onYes runs only if the user confirms.
func (c *confirmModel) Show(question string, onYes tea.Cmd) {
	c.question, c.onYes, c.active = question, onYes, true
}

func (c *confirmModel) Active() bool { return c.active }

func (c *confirmModel) Hide() {
	c.active = false
	c.onYes = nil
}

// Update consumes every key while active: y/enter confirms, n/esc cancels,
// anything else is swallowed (the modal is, well, modal). handled=false means
// the message is the embedding screen's problem.
func (c *confirmModel) Update(msg tea.Msg) (handled bool, cmd tea.Cmd) {
	if !c.active {
		return false, nil
	}
	if _, isMouse := msg.(tea.MouseMsg); isMouse {
		return true, nil // no click-through to what's behind the modal
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return false, nil
	}
	switch k.String() {
	case "y", "Y", "enter":
		cmd = c.onYes
		c.Hide()
		return true, cmd
	case "n", "N", "esc":
		c.Hide()
		return true, nil
	}
	return true, nil
}

func (c *confirmModel) help() []keyHint {
	return []keyHint{{"y/enter", "confirm"}, {"n/esc", "cancel"}}
}

// Overlay splices the modal box over the middle rows of base (w×h is the body
// area, i.e. the screen minus the root chrome). Inactive → base unchanged.
func (c *confirmModel) Overlay(base string, w, h int) string {
	if !c.active {
		return base
	}
	boxW := min(max(lipgloss.Width(c.question)+8, 34), max(w-4, 20))
	body := stTitle.Render("Confirm") + "\n\n" +
		c.question + "\n\n" +
		stMuted.Render("y/enter confirm · n/esc cancel")
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colAccent)).
		Padding(0, 2).
		Width(boxW).
		Render(body)

	boxLines := strings.Split(box, "\n")
	lines := strings.Split(base, "\n")
	for len(lines) < h {
		lines = append(lines, "")
	}
	top := (len(lines) - len(boxLines)) / 2
	if top < 0 {
		top = 0
	}
	for i, bl := range boxLines {
		if top+i >= len(lines) {
			break
		}
		lines[top+i] = lipgloss.PlaceHorizontal(w, lipgloss.Center, bl)
	}
	return strings.Join(lines, "\n")
}
