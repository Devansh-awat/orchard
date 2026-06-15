package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Palette lifted from the app's dark theme (frontend/src/lib/ui-kit/theme.css)
// so the TUI reads as the same product.
const (
	colBg       = "#1d1d1f" // --center-channel-bg
	colSurface  = "#2d2d2f" // --sidebar-text-active-bg (selection)
	colBorder   = "#3a2c2e" // between surface-border and active bg, reads well on dark
	colText     = "#f9e8ea" // --center-channel-color
	colMuted    = "#dcb8be" // --surface-muted
	colAccent   = "#c93a4f" // --sidebar-text-active-border
	colButton   = "#b33346" // --button-bg
	colLink     = "#f3a8b2" // --link-color
	colGreen    = "#33d6a6" // --online-indicator
	colYellow   = "#f1c40f" // --away-indicator
	colRed      = "#ff6b7d" // --dnd / error
	colLogo     = "#BF3747" // brand red for the logo mark
	colHeaderBg = "#2d2d2f" // top bar background
)

var (
	stTitle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colText))
	stAccent   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colAccent))
	stMuted    = lipgloss.NewStyle().Foreground(lipgloss.Color(colMuted))
	stLink     = lipgloss.NewStyle().Foreground(lipgloss.Color(colLink))
	stGreen    = lipgloss.NewStyle().Foreground(lipgloss.Color(colGreen))
	stYellow   = lipgloss.NewStyle().Foreground(lipgloss.Color(colYellow))
	stRed      = lipgloss.NewStyle().Foreground(lipgloss.Color(colRed))
	stSelected = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colText)).Background(lipgloss.Color(colSurface))
	stSelBar   = lipgloss.NewStyle().Foreground(lipgloss.Color(colAccent))
	stKey      = lipgloss.NewStyle().Foreground(lipgloss.Color(colLink))
	stInputOn  = lipgloss.NewStyle().Foreground(lipgloss.Color(colText))

	stHeaderBar = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color(colText)).
			Background(lipgloss.Color(colButton)).
			Padding(0, 1)

	stCrumb = lipgloss.NewStyle().Foreground(lipgloss.Color(colMuted))

	stPanel = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colBorder)).
		Padding(0, 1)

	stTab       = lipgloss.NewStyle().Padding(0, 2).Foreground(lipgloss.Color(colMuted))
	stTabActive = lipgloss.NewStyle().Padding(0, 2).Bold(true).
			Foreground(lipgloss.Color(colText)).
			Background(lipgloss.Color(colSurface))

	stFooter = lipgloss.NewStyle().Foreground(lipgloss.Color(colMuted))
	stColHdr = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(colMuted))

	// on the solid header/footer bar
	stBarText  = lipgloss.NewStyle().Foreground(lipgloss.Color(colText)).Background(lipgloss.Color(colHeaderBg))
	stBarMuted = lipgloss.NewStyle().Foreground(lipgloss.Color(colMuted)).Background(lipgloss.Color(colHeaderBg))

	// tab segment embedded in a panel border
	stTabSel = lipgloss.NewStyle().Bold(true).Underline(true).Foreground(lipgloss.Color(colAccent))
)

// statusColor returns the brand hex for a lifecycle state.
func statusColor(s string) string {
	switch lc(s) {
	case "running", "ready", "active", "succeeded", "success", "healthy", "available", "complete":
		return colGreen
	case "pending", "building", "deploying", "provisioning", "progressing", "restoring", "containercreating":
		return colYellow
	case "failed", "error", "crashloopbackoff", "unhealthy", "cancelled", "imagepullbackoff", "oomkilled":
		return colRed
	}
	return colMuted
}

// statusStyle colorizes lifecycle states the same way across the app.
func statusStyle(s string) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(statusColor(s)))
}

// statusDot renders a colored ● plus the lowercased state.
func statusDot(s string) string {
	if s == "" {
		return stMuted.Render("○ —")
	}
	return statusStyle(s).Render("● " + s)
}

// badge renders a filled pill, used for the prominent status in detail views.
func badge(s string) string {
	if s == "" {
		s = "unknown"
	}
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(colBg)).
		Background(lipgloss.Color(statusColor(s))).
		Bold(true).Padding(0, 1).
		Render(strings.ToUpper(s))
}

func boxStyle(w int) lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(colBorder)).
		Padding(0, 1).
		MarginLeft(2).
		Width(min(w-6, 70))
}

func lc(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 32
		}
	}
	return string(b)
}
