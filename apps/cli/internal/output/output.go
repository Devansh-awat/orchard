package output

import (
	"encoding/json"
	"errors"
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

// Status lines go to stderr so piped stdout stays pure data (agents parse it).
func Successf(format string, a ...any) {
	fmt.Fprintln(os.Stderr, okStyle.Render("✓ ")+fmt.Sprintf(format, a...))
}
func Warnf(format string, a ...any) {
	fmt.Fprintln(os.Stderr, warnStyle.Render("! ")+fmt.Sprintf(format, a...))
}
func Errorf(format string, a ...any) {
	fmt.Fprintln(os.Stderr, errStyle.Render("✗ ")+fmt.Sprintf(format, a...))
}
func Dim(s string) string { return dimStyle.Render(s) }

// KV renders an aligned key/value detail view (the table-mode counterpart of
// a JSON `get` dump).
func KV(pairs [][2]string) {
	w := 0
	for _, p := range pairs {
		if lipgloss.Width(p[0]) > w {
			w = lipgloss.Width(p[0])
		}
	}
	var b strings.Builder
	for _, p := range pairs {
		b.WriteString(dimStyle.Render(pad(p[0], w)))
		b.WriteString("  ")
		b.WriteString(p[1])
		b.WriteString("\n")
	}
	fmt.Print(b.String())
}

// NDJSON prints v as a single line (streaming: events tail, --follow).
func NDJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

// ErrPromptRefused is returned when a confirmation would block a non-TTY
// caller; commands surface it as a usage error (exit 2).
var ErrPromptRefused = errors.New("refusing to prompt in non-interactive mode; pass --yes to confirm")

// Confirm gates destructive actions. --yes skips it; without a terminal it
// fails immediately rather than hanging an agent or CI job.
func Confirm(prompt string, yes bool) error {
	if yes {
		return nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) || !IsTTY() {
		return ErrPromptRefused
	}
	fmt.Fprintf(os.Stderr, "%s [y/N] ", prompt)
	var line string
	_, _ = fmt.Fscanln(os.Stdin, &line)
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return nil
	}
	return errors.New("aborted")
}

func ConfirmTyped(prompt, expected string, yes bool) error {
	if yes {
		return nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) || !IsTTY() {
		return ErrPromptRefused
	}
	fmt.Fprintf(os.Stderr, "%s\nThis is permanent and cannot be undone. Type %q to confirm: ", prompt, expected)
	var line string
	_, _ = fmt.Fscanln(os.Stdin, &line)
	if strings.TrimSpace(line) == expected {
		return nil
	}
	return errors.New("aborted: name did not match")
}

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
