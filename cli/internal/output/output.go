package output

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"golang.org/x/term"
)

// Format is resolved once per command from the --output flag + TTY detection.
type Format string

const (
	FormatJSON  Format = "json"
	FormatTable Format = "table"
)

var (
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("213"))
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("214"))
	errStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("196"))
)

// Resolve picks the effective format. Explicit flag wins; otherwise pretty for a
// TTY, json when piped or when an agent sets ORCHARD_JSON=1.
func Resolve(flag string) Format {
	switch strings.ToLower(flag) {
	case "json":
		return FormatJSON
	case "table", "pretty":
		return FormatTable
	}
	if os.Getenv("ORCHARD_JSON") == "1" {
		return FormatJSON
	}
	if IsTTY() {
		return FormatTable
	}
	return FormatJSON
}

func IsTTY() bool {
	return term.IsTerminal(int(os.Stdout.Fd()))
}

// JSON prints v as indented JSON to stdout.
func JSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// Raw prints already-encoded bytes (re-indenting JSON when possible).
func Raw(data []byte) {
	var v any
	if json.Unmarshal(data, &v) == nil {
		_ = JSON(v)
		return
	}
	os.Stdout.Write(data)
	if len(data) > 0 && data[len(data)-1] != '\n' {
		fmt.Println()
	}
}

// Table renders rows under headers using lipgloss column padding.
func Table(headers []string, rows [][]string) {
	if len(rows) == 0 {
		fmt.Println(dimStyle.Render("(no results)"))
		return
	}
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = lipgloss.Width(h)
	}
	for _, r := range rows {
		for i, c := range r {
			if i < len(widths) && lipgloss.Width(c) > widths[i] {
				widths[i] = lipgloss.Width(c)
			}
		}
	}

	var b strings.Builder
	for i, h := range headers {
		b.WriteString(headerStyle.Render(pad(strings.ToUpper(h), widths[i])))
		if i < len(headers)-1 {
			b.WriteString("  ")
		}
	}
	b.WriteString("\n")
	for _, r := range rows {
		for i := range headers {
			cell := ""
			if i < len(r) {
				cell = r[i]
			}
			b.WriteString(pad(cell, widths[i]))
			if i < len(headers)-1 {
				b.WriteString("  ")
			}
		}
		b.WriteString("\n")
	}
	fmt.Print(b.String())
}

func pad(s string, w int) string {
	gap := w - lipgloss.Width(s)
	if gap <= 0 {
		return s
	}
	return s + strings.Repeat(" ", gap)
}

func Successf(format string, a ...any) {
	fmt.Println(okStyle.Render("✓ ") + fmt.Sprintf(format, a...))
}
func Warnf(format string, a ...any) { fmt.Println(warnStyle.Render("! ") + fmt.Sprintf(format, a...)) }
func Errorf(format string, a ...any) {
	fmt.Fprintln(os.Stderr, errStyle.Render("✗ ")+fmt.Sprintf(format, a...))
}
func Dim(s string) string { return dimStyle.Render(s) }

// Status colorizes common lifecycle states for table cells.
func Status(s string) string {
	switch strings.ToLower(s) {
	case "running", "ready", "active", "succeeded", "healthy", "available":
		return okStyle.Render(s)
	case "pending", "building", "deploying", "provisioning", "progressing":
		return warnStyle.Render(s)
	case "failed", "error", "crashloopbackoff", "unhealthy", "cancelled":
		return errStyle.Render(s)
	}
	return s
}
