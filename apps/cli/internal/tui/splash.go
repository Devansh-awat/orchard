package tui

import (
	"context"
	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// logoArt is the Orchard mark (apple + leaf).
const logoArt = `████████████████████
████████▓▒░░▒▓██████
██████▒   ░░  ░▓▓▓██
█████▒ ░▓▓▒▓█▓     ▒
█████  █▓   ░██▒▓█░
███▒  ░██░  █▓   ▒█
███  ▓▓  ░███▓   ▓█
██▓  █░   ▒▓░░▓██▒
███░ ░█▒▒▓█    ▓█  █
████▒     ▓▓  ▒█░ ░█
██████▓▒░  ░░░░  ░██`

type meMsg struct {
	email string
	err   error
}

func fetchMe(cl *api.Client) tea.Cmd {
	return func() tea.Msg {
		var me map[string]any
		if err := cl.GetJSON(context.Background(), "/auth/me", &me); err != nil {
			return meMsg{err: err}
		}
		email, _ := me["email"].(string)
		return meMsg{email: email}
	}
}

type splashScreen struct {
	cl    *api.Client
	email string
	err   error
	w, h  int
}

func newSplashScreen(cl *api.Client) *splashScreen { return &splashScreen{cl: cl} }

func (s *splashScreen) title() string { return "Welcome" }

func (s *splashScreen) help() []keyHint { return []keyHint{{"enter", "continue"}, {"q", "quit"}} }

func (s *splashScreen) Init() tea.Cmd { return fetchMe(s.cl) }

func (s *splashScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case meMsg:
		s.email, s.err = msg.email, msg.err
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return s, tea.Quit
		case "enter", " ":
			return s, replace(newProjectsScreen(s.cl))
		}
	}
	return s, nil
}

func (s *splashScreen) View() string {
	logoStyle := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colLogo))
	logo := logoStyle.Render(logoArt)

	title := stTitle.Render("Welcome to ") + stAccent.Render("Orchard")
	subtitle := stMuted.Render("deploy, configure, and monitor — from your terminal")

	greet := stMuted.Render("checking session…")
	if s.err != nil {
		greet = stRed.Render("not signed in · run `orchard auth login`")
	} else if s.email != "" {
		greet = stGreen.Render("● ") + stMuted.Render("signed in as ") + stInputOn.Render(s.email)
	}

	hint := stFooter.Render("press enter to continue · q to quit")

	block := lipgloss.JoinVertical(lipgloss.Center,
		logo, "", title, subtitle, "", greet, "", hint,
	)

	availH := s.h - chromeH
	if availH < 1 {
		availH = 1
	}
	return lipgloss.Place(s.w, availH, lipgloss.Center, lipgloss.Center, block)
}
