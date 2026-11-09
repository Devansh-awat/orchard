package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func typeInto(m tea.Model, s string) tea.Model {
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)})
	return m
}

func TestInstancePromptShowsAProblemAndLetsYouRetry(t *testing.T) {
	calls := []string{}
	var m tea.Model = newInstancePrompt(context.Background(), func(_ context.Context, raw string) (string, error) {
		calls = append(calls, raw)
		if raw != "good" {
			return "", errors.New("couldn't reach that host")
		}
		return "https://good.example", nil
	})
	m = typeInto(m, "bad")
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if !strings.Contains(m.View(), "checking") {
		t.Fatalf("view while checking: %q", m.View())
	}
	m, _ = m.Update(cmd())
	if !strings.Contains(m.View(), "couldn't reach that host") || m.(instancePromptModel).done {
		t.Fatalf("view after failure: %q", m.View())
	}
	for range 3 {
		m, _ = m.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	}
	m = typeInto(m, "good")
	m, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m, quit := m.Update(cmd())
	res := m.(instancePromptModel)
	if !res.done || res.url != "https://good.example" || quit == nil || len(calls) != 2 {
		t.Fatalf("res = %+v, calls = %v", res, calls)
	}
}

func TestInstancePromptIgnoresEnterAndTypingWhileChecking(t *testing.T) {
	var m tea.Model = newInstancePrompt(context.Background(), func(context.Context, string) (string, error) { return "", nil })
	m = typeInto(m, "a")
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m, again := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = typeInto(m, "b")
	if again != nil || m.(instancePromptModel).input.Value() != "a" {
		t.Fatalf("again = %v, value = %q", again, m.(instancePromptModel).input.Value())
	}
}

func TestInstancePromptCancelStopsTheCheck(t *testing.T) {
	seen := make(chan context.Context, 1)
	var m tea.Model = newInstancePrompt(context.Background(), func(ctx context.Context, _ string) (string, error) {
		seen <- ctx
		<-ctx.Done()
		return "", ctx.Err()
	})
	m = typeInto(m, "slow")
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	ctx := <-seen
	m, quit := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if quit == nil || ctx.Err() == nil || !m.(instancePromptModel).aborted {
		t.Fatalf("quit = %v, ctx err = %v", quit, ctx.Err())
	}
	m, _ = m.Update(<-done)
	if m.(instancePromptModel).done || m.View() != "" {
		t.Fatalf("view after cancel: %q", m.View())
	}
}
