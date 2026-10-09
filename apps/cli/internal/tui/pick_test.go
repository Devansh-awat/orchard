package tui

import (
	"reflect"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func pickKey(m pickModel, keys ...string) pickModel {
	for _, k := range keys {
		var msg tea.KeyMsg
		switch k {
		case "enter":
			msg = tea.KeyMsg{Type: tea.KeyEnter}
		case "esc":
			msg = tea.KeyMsg{Type: tea.KeyEsc}
		case "down":
			msg = tea.KeyMsg{Type: tea.KeyDown}
		case " ":
			msg = tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
		default:
			msg = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
		}
		next, _ := m.Update(msg)
		m = next.(pickModel)
	}
	return m
}

func TestPickManyTogglesAndConfirms(t *testing.T) {
	opts := []PickOption{
		{Group: "agent", Label: "reviewer"},
		{Group: "agent", Label: "writer"},
		{Group: "mcp", Label: "github", Detail: "contains secrets: GITHUB_TOKEN"},
	}
	m := newPickModel("pick", opts)
	if got := m.picked(); !reflect.DeepEqual(got, []int{0, 1, 2}) {
		t.Fatalf("everything should start selected, got %v", got)
	}
	view := m.View()
	for _, want := range []string{"agent", "mcp", "reviewer", "GITHUB_TOKEN", "3 of 3 selected"} {
		if !strings.Contains(view, want) {
			t.Errorf("view missing %q:\n%s", want, view)
		}
	}

	m = pickKey(m, "down", " ", "enter")
	if !m.done || m.aborted {
		t.Fatal("enter should confirm")
	}
	if got := m.picked(); !reflect.DeepEqual(got, []int{0, 2}) {
		t.Errorf("picked = %v, want [0 2]", got)
	}

	m = pickKey(newPickModel("pick", opts), "a")
	if got := m.picked(); len(got) != 0 {
		t.Errorf("a with everything selected should clear, got %v", got)
	}
	m = pickKey(m, "a")
	if got := m.picked(); len(got) != 3 {
		t.Errorf("a again should select everything, got %v", got)
	}

	if m = pickKey(newPickModel("pick", opts), "esc"); !m.aborted {
		t.Error("esc should abort")
	}
}

func TestPickManyWindowsLongLists(t *testing.T) {
	opts := make([]PickOption, 50)
	for i := range opts {
		opts[i] = PickOption{Group: "skill", Label: "item" + string(rune('A'+i%26)) + string(rune('a'+i/26))}
	}
	m := newPickModel("pick", opts)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 80, Height: 15})
	m = next.(pickModel)
	for range 40 {
		m = pickKey(m, "down")
	}
	view := m.View()
	if lines := strings.Count(view, "\n"); lines > 15 {
		t.Errorf("view is %d lines tall in a 15 line terminal", lines)
	}
	if !strings.Contains(view, opts[40].Label) {
		t.Errorf("the cursor row %s scrolled out of view:\n%s", opts[40].Label, view)
	}
}
