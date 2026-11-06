package output

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

type sanitizeMode struct {
	keepSGR     bool
	keepNewline bool
	anySGR      bool
}

var (
	modePlain      = sanitizeMode{keepNewline: true}
	modeStyled     = sanitizeMode{keepSGR: true, keepNewline: true}
	modeLine       = sanitizeMode{}
	modeView       = sanitizeMode{keepSGR: true, keepNewline: true, anySGR: true}
	modeStyledLine = sanitizeMode{keepSGR: true}
)

func Sanitize(s string) string { return sanitize(s, modePlain) }

func SanitizeLine(s string) string { return sanitize(s, modeLine) }

func SanitizeStyled(s string) string { return sanitize(s, modeStyled) }

func SanitizeView(s string) string { return sanitize(s, modeView) }

func SanitizeStyledLine(s string) string { return sanitize(s, modeStyledLine) }

func sanitize(s string, m sanitizeMode) string {
	if s == "" || !needsSanitizing(s, m) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		if c == 0x1b {
			i = skipEscape(s, i, m, &b)
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteRune(utf8.RuneError)
			i++
			continue
		}
		switch {
		case r == '\n' || r == '\t':
			if m.keepNewline {
				b.WriteRune(r)
			} else {
				b.WriteByte(' ')
			}
		case r == 0x9b:
			i = skipCSI(s, i+size, m, &b, false)
			continue
		case r == 0x9d || r == 0x90 || r == 0x98 || r == 0x9e || r == 0x9f:
			i = skipString(s, i+size)
			continue
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0):
		case isBidiControl(r):
		default:
			b.WriteRune(r)
		}
		i += size
	}
	return b.String()
}

func needsSanitizing(s string, m sanitizeMode) bool {
	if !utf8.ValidString(s) {
		return true
	}
	for _, r := range s {
		if r == '\n' || r == '\t' {
			if !m.keepNewline {
				return true
			}
			continue
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || isBidiControl(r) {
			return true
		}
	}
	return false
}

func isBidiControl(r rune) bool {
	return (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069)
}

func skipEscape(s string, i int, m sanitizeMode, b *strings.Builder) int {
	i++
	if i >= len(s) {
		return i
	}
	switch s[i] {
	case '[':
		return skipCSI(s, i+1, m, b, true)
	case ']', 'P', 'X', '^', '_':
		return skipString(s, i+1)
	}
	for i < len(s) && s[i] >= 0x20 && s[i] <= 0x2f {
		i++
	}
	if i < len(s) && s[i] >= 0x30 && s[i] <= 0x7e {
		i++
	}
	return i
}

func skipCSI(s string, i int, m sanitizeMode, b *strings.Builder, ascii bool) int {
	start := i
	for i < len(s) && s[i] >= 0x30 && s[i] <= 0x3f {
		i++
	}
	paramEnd := i
	for i < len(s) && s[i] >= 0x20 && s[i] <= 0x2f {
		i++
	}
	if i >= len(s) || s[i] < 0x40 || s[i] > 0x7e {
		return i
	}
	final := s[i]
	i++
	if m.keepSGR && ascii && final == 'm' && paramEnd == i-1 && (sgrAllowed(s[start:paramEnd]) || (m.anySGR && viewSGRAllowed(s[start:paramEnd]))) {
		b.WriteString("\x1b[")
		b.WriteString(s[start:paramEnd])
		b.WriteByte('m')
	}
	return i
}

func skipString(s string, i int) int {
	for i < len(s) {
		switch {
		case s[i] == 0x07:
			return i + 1
		case s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\':
			return i + 2
		case s[i] == 0x1b:
			return i
		case s[i] == 0xc2 && i+1 < len(s) && s[i+1] == 0x9c:
			return i + 2
		}
		i++
	}
	return i
}

func sgrAllowed(params string) bool {
	if params == "" {
		return true
	}
	parts := strings.Split(params, ";")
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			if parts[i] == "" {
				continue
			}
			return false
		}
		switch {
		case n == 0 || n == 1 || n == 2 || n == 3 || n == 4 || n == 22 || n == 23 || n == 24 || n == 39:
		case n >= 31 && n <= 37, n >= 90 && n <= 97:
		case n == 38:
			if i+2 < len(parts) && parts[i+1] == "5" {
				v, verr := strconv.Atoi(parts[i+2])
				if verr != nil || v < 0 || v > 255 {
					return false
				}
				i += 2
			} else if i+4 < len(parts) && parts[i+1] == "2" {
				for _, p := range parts[i+2 : i+5] {
					v, verr := strconv.Atoi(p)
					if verr != nil || v < 0 || v > 255 {
						return false
					}
				}
				i += 4
			} else {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func escapeJSONControls(s string) string {
	clean := true
	for _, r := range s {
		if (r >= 0x80 && r < 0xa0) || isBidiControl(r) {
			clean = false
			break
		}
	}
	if clean {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 0x80 && r < 0xa0) || isBidiControl(r) {
			b.WriteString(`\u`)
			b.WriteString(strings.ToLower(strconv.FormatInt(int64(r)+0x10000, 16)[1:]))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func Print(a ...any) { os.Stdout.WriteString(SanitizeStyled(fmt.Sprint(a...))) }

func Println(a ...any) { os.Stdout.WriteString(SanitizeStyled(fmt.Sprintln(a...))) }

func Printf(format string, a ...any) {
	os.Stdout.WriteString(SanitizeStyled(fmt.Sprintf(format, a...)))
}

func Fprint(w io.Writer, a ...any) { io.WriteString(w, SanitizeStyled(fmt.Sprint(a...))) }

func Fprintln(w io.Writer, a ...any) { io.WriteString(w, SanitizeStyled(fmt.Sprintln(a...))) }

func Fprintf(w io.Writer, format string, a ...any) {
	io.WriteString(w, SanitizeStyled(fmt.Sprintf(format, a...)))
}

func viewSGRAllowed(params string) bool {
	parts := strings.FieldsFunc(params, func(r rune) bool { return r == ';' || r == ':' })
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 || n > 107 {
			return false
		}
		switch n {
		case 5, 6, 8, 28:
			return false
		case 38, 48, 58:
			if i+1 >= len(parts) {
				return false
			}
			switch parts[i+1] {
			case "5":
				i += 2
			case "2":
				i += 4
			default:
				return false
			}
		}
	}
	return true
}
