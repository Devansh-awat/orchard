package tui

import (
	"fmt"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

type projectsMsg struct {
	items []Project
	err   error
}

func fetchProjects(cl *api.Client) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Project](cl, "/projects")
		return projectsMsg{items, err}
	}
}

type projectsScreen struct {
	cl      *api.Client
	items   []Project
	cursor  int
	loading bool
	err     error
	hit     hitTable
	w, h    int
}

func newProjectsScreen(cl *api.Client) *projectsScreen {
	return &projectsScreen{cl: cl, loading: true}
}

func (s *projectsScreen) title() string { return "Projects" }

func (s *projectsScreen) Init() tea.Cmd { return fetchProjects(s.cl) }

func (s *projectsScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case projectsMsg:
		s.loading = false
		s.err = msg.err
		s.items = msg.items
		if s.cursor >= len(s.items) {
			s.cursor = 0
		}
	case projectCreatedMsg:
		// returned from the new-project form
		return s, tea.Batch(fetchProjects(s.cl), flashf("created project %s", msg.name))
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.cursor > 0 {
				s.cursor--
			}
		case tea.MouseButtonWheelDown:
			if s.cursor < len(s.items)-1 {
				s.cursor++
			}
		case tea.MouseButtonLeft:
			if msg.Action == tea.MouseActionPress {
				if idx := s.hit.rowAt(msg.X, msg.Y, s.cursor); idx >= 0 {
					if idx == s.cursor {
						return s, push(newProjectScreen(s.cl, s.items[idx]))
					}
					s.cursor = idx
				}
			}
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k":
			if s.cursor > 0 {
				s.cursor--
			}
		case "down", "j":
			if s.cursor < len(s.items)-1 {
				s.cursor++
			}
		case "r":
			s.loading = true
			return s, fetchProjects(s.cl)
		case "n":
			return s, push(newProjectFormScreen(s.cl))
		case "enter":
			if s.cursor < len(s.items) {
				p := s.items[s.cursor]
				return s, push(newProjectScreen(s.cl, p))
			}
		}
	}
	return s, nil
}

func (s *projectsScreen) help() []keyHint {
	return []keyHint{{"↑/↓", "move"}, {"enter", "open"}, {"n", "new"}, {"r", "refresh"}, {"q", "quit"}}
}

func (s *projectsScreen) View() string {
	bodyH := s.h - chromeH
	leftW := s.w * 11 / 18
	rightW := s.w - leftW

	var listBody string
	switch {
	case s.loading:
		listBody = stMuted.Render("loading projects…")
	case s.err != nil:
		listBody = stRed.Render("✗ " + s.err.Error())
	default:
		rows := make([][]string, len(s.items))
		for i, p := range s.items {
			rows[i] = []string{p.Name, stMuted.Render(p.Slug)}
		}
		cols := []col{{title: "NAME"}, {title: "SLUG"}}
		listBody = renderTable(cols, rows, s.cursor, leftW-2, bodyH-2)
		s.hit = hitTable{topY: 4, visible: bodyH - 4, count: len(s.items), minX: 0, maxX: leftW - 1}
	}

	left := panel(fmt.Sprintf("Projects (%d)", len(s.items)), listBody, leftW, bodyH, true)
	right := panel("Details", s.previewBody(), rightW, bodyH, false)
	return sideBySide(left, right)
}

func (s *projectsScreen) previewBody() string {
	if s.cursor >= len(s.items) {
		return stMuted.Render("no selection")
	}
	p := s.items[s.cursor]
	org := p.Organization.Name
	if org == "" {
		org = p.OrganizationID
	}
	var b strings.Builder
	kv := func(k, v string) { b.WriteString(stKey.Render(pad(k, 12)) + " " + v + "\n") }
	b.WriteString(stTitle.Render(p.Name) + "\n\n")
	kv("Slug", stMuted.Render(p.Slug))
	kv("Org", stLink.Render(org))
	kv("Deployments", fmt.Sprintf("%d", p.Count.Deployments))
	kv("Databases", fmt.Sprintf("%d", p.Count.Databases))
	if p.Description != "" {
		b.WriteString("\n" + stMuted.Render(p.Description) + "\n")
	}
	b.WriteString("\n" + stFooter.Render("press enter to open →"))
	return b.String()
}
