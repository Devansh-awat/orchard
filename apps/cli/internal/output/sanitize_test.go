package output

import (
	"strings"
	"testing"
)

func TestSanitizeStripsEscapeSequences(t *testing.T) {
	cases := map[string]string{
		"plain text":                 "plain text",
		"a\x1b[2Jb":                  "ab",
		"a\x1b[31mred\x1b[0mb":       "aredb",
		"a\x1b]0;evil title\x07b":    "ab",
		"a\x1b]52;c;ZXZpbA==\x1b\\b": "ab",
		"a\x1bPq#0;2;0;0;0\x1b\\b":   "ab",
		"a\x1b_payload\x1b\\b":       "ab",
		"a\x1bc b":                   "a b",
		"a\x1b(0b":                   "ab",
		"a\u009b2Jb":                 "ab",
		"a\u009d0;t\u009cb":          "ab",
		"a\rb":                       "ab",
		"a\x00\x07\x08\x7fb":         "ab",
		"keep\nnewline\tand tab":     "keep\nnewline\tand tab",
		"bidi\u202egnp.exe":          "bidignp.exe",
		"\x1b":                       "",
		"trail\x1b[":                 "trail",
		"héllo wörld 日本語":            "héllo wörld 日本語",
		"bad\xc2utf8":                "bad�utf8",
		"raw c1 \x9b2J":              "raw c1 �2J",
		"a\x1b[?1049hb":              "ab",
		"a\x1b[1;1Hb":                "ab",
		"a\x1b]8;;http://evil\x07link\x1b]8;;\x07": "alink",
	}
	for in, want := range cases {
		if got := Sanitize(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeLineFlattensNewlinesAndTabs(t *testing.T) {
	if got := SanitizeLine("a\nb\tc\r\nd"); got != "a b c d" {
		t.Fatalf("got %q", got)
	}
	if got := SanitizeLine("Evil\n\x1b[2K\x1b[1AFake Org"); got != "Evil Fake Org" {
		t.Fatalf("got %q", got)
	}
}

func TestSanitizeStyledKeepsOnlyHarmlessColour(t *testing.T) {
	cases := map[string]string{
		"\x1b[31mred\x1b[0m":               "\x1b[31mred\x1b[0m",
		"\x1b[1;32mok\x1b[22;39m":          "\x1b[1;32mok\x1b[22;39m",
		"\x1b[38;5;244mdim\x1b[0m":         "\x1b[38;5;244mdim\x1b[0m",
		"\x1b[38;2;1;2;3mrgb\x1b[0m":       "\x1b[38;2;1;2;3mrgb\x1b[0m",
		"\x1b[8mhidden\x1b[0m":             "hidden\x1b[0m",
		"\x1b[7mreverse\x1b[0m":            "reverse\x1b[0m",
		"\x1b[41mbg\x1b[0m":                "bg\x1b[0m",
		"\x1b[2Jclear":                     "clear",
		"\x1b[10;10Hmove":                  "move",
		"\x1b[?25linvisible cursor":        "invisible cursor",
		"\x1b]0;title\x07text":             "text",
		"\x1b[38;5;999mbad\x1b[0m":         "bad\x1b[0m",
		"\x1b[31;2Jmixed":                  "mixed",
		"\x1b[31m\x1b[2Jboth":              "\x1b[31mboth",
		"\x1b[31;41mhas background\x1b[0m": "has background\x1b[0m",
	}
	for in, want := range cases {
		if got := SanitizeStyled(in); got != want {
			t.Errorf("SanitizeStyled(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeViewKeepsLayoutColoursButNotTerminalControl(t *testing.T) {
	cases := map[string]string{
		"\x1b[7m\x1b[48;5;236mrow\x1b[0m": "\x1b[7m\x1b[48;5;236mrow\x1b[0m",
		"\x1b[8mhidden\x1b[0m":            "hidden\x1b[0m",
		"\x1b[5mblink\x1b[0m":             "blink\x1b[0m",
		"\x1b[2J\x1b[Hgone":               "gone",
		"\x1b]52;c;AAAA\x07":              "",
		"a\rb":                            "ab",
	}
	for in, want := range cases {
		if got := SanitizeView(in); got != want {
			t.Errorf("SanitizeView(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSanitizeLeavesNoControlBytes(t *testing.T) {
	hostile := "\x1b[2J\x1b]52;c;x\x07\x9b31m\x00\x08\r‮\x1bP1$r\x1b\\end"
	for name, got := range map[string]string{
		"plain":  Sanitize(hostile),
		"line":   SanitizeLine(hostile),
		"styled": SanitizeStyled(hostile),
		"view":   SanitizeView(hostile),
	} {
		if strings.ContainsAny(got, "\x1b\x07\x00\x08\r\u009b‮") {
			t.Errorf("%s kept a control byte: %q", name, got)
		}
	}
}

func TestEscapeJSONControlsEscapesC1AndBidi(t *testing.T) {
	got := escapeJSONControls("\"a\u009b2J‮b\"")
	if got != "\"a\\u009b2J\\u202eb\"" {
		t.Fatalf("got %q", got)
	}
	if got := escapeJSONControls(`"héllo"`); got != `"héllo"` {
		t.Fatalf("clean strings must pass through: %q", got)
	}
}
