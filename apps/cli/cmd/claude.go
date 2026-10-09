package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/hackclub/orchard/cli/internal/exitcode"
	"github.com/hackclub/orchard/cli/internal/output"
	"github.com/hackclub/orchard/cli/internal/tui"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

const (
	claudeMaxFileBytes = 256 << 10
	claudeMaxItemBytes = 1 << 20
	claudeMaxItems     = 200
	claudeContextPath  = "/me/context"
)

var (
	claudeKinds  = []string{"instructions", "agent", "command", "skill", "mcp"}
	claudeNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)

	errClaudeTooBig = errors.New("over the 256 KiB file limit")
	errClaudeBinary = errors.New("not a UTF-8 text file")
)

type claudeImportItem struct {
	Kind  string            `json:"kind"`
	Name  string            `json:"name"`
	Files map[string]string `json:"files,omitempty"`
	MCP   map[string]any    `json:"mcp,omitempty"`
}

type claudeFound struct {
	Item    claudeImportItem
	Size    int
	Secrets []string
}

type claudeScan struct {
	Found   []claudeFound
	Skipped []string
}

type claudeDryRunItem struct {
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	SizeBytes  int      `json:"sizeBytes"`
	Files      []string `json:"files,omitempty"`
	SecretKeys []string `json:"secretKeys,omitempty"`
}

func (s *claudeScan) skip(format string, a ...any) {
	s.Skipped = append(s.Skipped, fmt.Sprintf(format, a...))
}

func (s *claudeScan) add(item claudeImportItem, secrets []string) {
	if !claudeNameRe.MatchString(item.Name) {
		s.skip("%s %q: names must be 1-64 letters, digits, '.', '_', ':' or '-', starting with a letter or digit", item.Kind, item.Name)
		return
	}
	size := claudeItemSize(item)
	if size > claudeMaxItemBytes {
		s.skip("%s %s: %s is over the 1 MiB item limit", item.Kind, item.Name, quotaHumanBytes(float64(size)))
		return
	}
	s.Found = append(s.Found, claudeFound{Item: item, Size: size, Secrets: secrets})
}

func claudeItemSize(item claudeImportItem) int {
	n := 0
	for _, v := range item.Files {
		n += len(v)
	}
	if item.MCP != nil {
		b, _ := json.Marshal(item.MCP)
		n += len(b)
	}
	return n
}

func parseClaudeKinds(only []string) (map[string]bool, error) {
	kinds := map[string]bool{}
	for _, k := range only {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" {
			continue
		}
		if !slices.Contains(claudeKinds, k) {
			return nil, &exitcode.UsageError{Err: fmt.Errorf("unknown kind %q for --only (choose from %s)", k, strings.Join(claudeKinds, ","))}
		}
		kinds[k] = true
	}
	if len(kinds) == 0 {
		for _, k := range claudeKinds {
			kinds[k] = true
		}
	}
	return kinds, nil
}

func scanClaude(dir string, kinds map[string]bool) (*claudeScan, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("no Claude Code config at %s: %w", dir, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", dir)
	}
	s := &claudeScan{}
	if kinds["instructions"] {
		s.scanInstructions(dir)
	}
	if kinds["agent"] {
		s.scanAgents(dir)
	}
	if kinds["command"] {
		s.scanCommands(dir)
	}
	if kinds["skill"] {
		s.scanSkills(dir)
	}
	if kinds["mcp"] {
		s.scanMCP(dir)
	}
	slices.SortStableFunc(s.Found, func(a, b claudeFound) int {
		if d := slices.Index(claudeKinds, a.Item.Kind) - slices.Index(claudeKinds, b.Item.Kind); d != 0 {
			return d
		}
		return strings.Compare(a.Item.Name, b.Item.Name)
	})
	return s, nil
}

func readClaudeText(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > claudeMaxFileBytes {
		return "", errClaudeTooBig
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > claudeMaxFileBytes {
		return "", errClaudeTooBig
	}
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", errClaudeBinary
	}
	return string(data), nil
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func (s *claudeScan) scanInstructions(dir string) {
	text, err := readClaudeText(filepath.Join(dir, "CLAUDE.md"))
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		s.skip("instructions CLAUDE.md: %v", err)
		return
	}
	s.add(claudeImportItem{Kind: "instructions", Name: "CLAUDE.md", Files: map[string]string{"CLAUDE.md": text}}, nil)
}

func (s *claudeScan) scanAgents(dir string) {
	root := filepath.Join(dir, "agents")
	entries, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.skip("agents: %v", err)
		}
		return
	}
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".md")
		path := filepath.Join(root, e.Name())
		if !ok || strings.HasPrefix(e.Name(), ".") || !isRegularFile(path) {
			continue
		}
		text, err := readClaudeText(path)
		if err != nil {
			s.skip("agent %s: %v", name, err)
			continue
		}
		s.add(claudeImportItem{Kind: "agent", Name: name, Files: map[string]string{name + ".md": text}}, nil)
	}
}

func (s *claudeScan) scanCommands(dir string) {
	root := filepath.Join(dir, "commands")
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path != root || !errors.Is(err, fs.ErrNotExist) {
				s.skip("commands: %v", err)
			}
			return nil
		}
		if path == root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") || !isRegularFile(path) {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		name := strings.ReplaceAll(filepath.ToSlash(strings.TrimSuffix(rel, ".md")), "/", ":")
		text, err := readClaudeText(path)
		if err != nil {
			s.skip("command %s: %v", name, err)
			return nil
		}
		s.add(claudeImportItem{Kind: "command", Name: name, Files: map[string]string{name + ".md": text}}, nil)
		return nil
	})
}

func (s *claudeScan) scanSkills(dir string) {
	root := filepath.Join(dir, "skills")
	entries, err := os.ReadDir(root)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.skip("skills: %v", err)
		}
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") || e.Name() == "node_modules" {
			continue
		}
		skillDir, err := filepath.EvalSymlinks(filepath.Join(root, e.Name()))
		if err != nil {
			continue
		}
		if info, err := os.Stat(skillDir); err != nil || !info.IsDir() {
			continue
		}
		if info, err := os.Lstat(filepath.Join(skillDir, "SKILL.md")); err != nil || !info.Mode().IsRegular() {
			continue
		}
		s.scanSkill(e.Name(), skillDir)
	}
}

func (s *claudeScan) scanSkill(name, skillDir string) {
	files := map[string]string{}
	left := []string{}
	_ = filepath.WalkDir(skillDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == skillDir {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules" {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(skillDir, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		text, err := readClaudeText(path)
		if err != nil {
			left = append(left, rel)
			return nil
		}
		files[rel] = text
		return nil
	})
	if _, ok := files["SKILL.md"]; !ok {
		s.skip("skill %s: SKILL.md is not a text file under 256 KiB", name)
		return
	}
	if len(left) > 0 {
		s.skip("%d file(s) from skill %s (binary or over 256 KiB): %s", len(left), name, strings.Join(left, ", "))
	}
	s.add(claudeImportItem{Kind: "skill", Name: name, Files: files}, nil)
}

func readMCPServers(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var doc struct {
		MCPServers map[string]any `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	return doc.MCPServers, nil
}

func (s *claudeScan) scanMCP(dir string) {
	servers := map[string]any{}
	for _, path := range []string{filepath.Join(dir, "settings.json"), filepath.Join(filepath.Dir(dir), ".claude.json")} {
		m, err := readMCPServers(path)
		if err != nil {
			s.skip("mcp servers in %s: %v", path, err)
			continue
		}
		maps.Copy(servers, m)
	}
	for _, name := range slices.Sorted(maps.Keys(servers)) {
		if strings.EqualFold(name, "orchard") {
			s.skip("mcp %s: the name is reserved for Orchard's own MCP server", name)
			continue
		}
		cfg, ok := servers[name].(map[string]any)
		if !ok {
			s.skip("mcp %s: not a server object", name)
			continue
		}
		s.add(claudeImportItem{Kind: "mcp", Name: name, MCP: cfg}, mcpSecretKeys(cfg))
	}
}

func mcpSecretKeys(cfg map[string]any) []string {
	keys := []string{}
	for _, field := range []string{"env", "headers"} {
		m, _ := cfg[field].(map[string]any)
		for k, v := range m {
			if v != nil && v != "" {
				keys = append(keys, k)
			}
		}
	}
	slices.Sort(keys)
	return slices.Compact(keys)
}

func claudeDryRun(found []claudeFound) []claudeDryRunItem {
	out := []claudeDryRunItem{}
	for _, f := range found {
		out = append(out, claudeDryRunItem{
			Kind:       f.Item.Kind,
			Name:       f.Item.Name,
			SizeBytes:  f.Size,
			Files:      slices.Sorted(maps.Keys(f.Item.Files)),
			SecretKeys: f.Secrets,
		})
	}
	return out
}

func claudeDetail(f claudeFound) string {
	d := quotaHumanBytes(float64(f.Size))
	if len(f.Secrets) > 0 {
		d += "  contains secrets: " + strings.Join(f.Secrets, ", ")
	}
	return d
}

func renderClaudeSummary(w io.Writer, found []claudeFound) {
	width := 0
	for _, f := range found {
		width = max(width, len(f.Item.Name))
	}
	total := 0
	for i, f := range found {
		if i == 0 || f.Item.Kind != found[i-1].Item.Kind {
			fmt.Fprintln(w, output.Dim(f.Item.Kind))
		}
		fmt.Fprintf(w, "  %-*s  %s\n", width, f.Item.Name, output.Dim(quotaHumanBytes(float64(f.Size))))
		if len(f.Secrets) > 0 {
			fmt.Fprintf(w, "  %-*s  contains secrets: %s\n", width, "", strings.Join(f.Secrets, ", "))
		}
		total += f.Size
	}
	fmt.Fprintf(w, "\n%d item(s), %s. Everything is encrypted at rest on Orchard.\n", len(found), quotaHumanBytes(float64(total)))
}

func pickClaudeItems(found []claudeFound) ([]claudeFound, error) {
	opts := make([]tui.PickOption, len(found))
	for i, f := range found {
		opts[i] = tui.PickOption{Group: f.Item.Kind, Label: f.Item.Name, Detail: claudeDetail(f)}
	}
	idx, ok, err := tui.PickMany("Import into Orchard (encrypted at rest)", opts)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("aborted")
	}
	out := make([]claudeFound, 0, len(idx))
	for _, i := range idx {
		out = append(out, found[i])
	}
	return out, nil
}

func claudeCmd() *cobra.Command {
	c := &cobra.Command{
		Use:     "claude",
		GroupID: groupCore,
		Short:   "Import your Claude Code setup into Orchard (CLAUDE.md, agents, commands, skills, MCP servers)",
	}
	c.AddCommand(claudeImportCmd(), claudeListCmd(), claudeRemoveCmd())
	return c
}

func claudeImportCmd() *cobra.Command {
	var from, dir string
	var dryRun bool
	var only []string
	c := &cobra.Command{
		Use:   "import",
		Short: "Import your Claude Code setup (CLAUDE.md, agents, commands, skills, MCP servers)",
		Long: "Scans a Claude Code config directory (default ~/.claude) for CLAUDE.md,\n" +
			"agents/*.md, commands/**/*.md and skills/<name>/, plus the mcpServers in\n" +
			"~/.claude.json and settings.json, and uploads the ones you pick to your\n" +
			"Orchard account. Everything is encrypted at rest on the server.\n\n" +
			"MCP servers are uploaded with their env and headers, so the summary lists\n" +
			"which keys carry values (never the values) before anything leaves this\n" +
			"machine. A server named \"orchard\" is reserved and never imported.\n\n" +
			"A terminal gets a picker with everything selected. --yes imports all of it\n" +
			"without asking (required when not a TTY). --dry-run shows what would be\n" +
			"sent and exits.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if from != "claude" {
				return &exitcode.UsageError{Err: fmt.Errorf("unsupported --from %q (only \"claude\" is supported)", from)}
			}
			kinds, err := parseClaudeKinds(only)
			if err != nil {
				return err
			}
			if dir == "" {
				home, err := os.UserHomeDir()
				if err != nil {
					return err
				}
				dir = filepath.Join(home, ".claude")
			}
			scan, err := scanClaude(dir, kinds)
			if err != nil {
				return err
			}
			for _, note := range scan.Skipped {
				output.Warnf("skipped %s", note)
			}
			if len(scan.Found) == 0 {
				output.Warnf("nothing to import from %s", dir)
				return nil
			}
			if dryRun {
				if fmtFlag() == output.FormatJSON {
					return output.JSON(map[string]any{"items": claudeDryRun(scan.Found), "skipped": scan.Skipped})
				}
				renderClaudeSummary(os.Stdout, scan.Found)
				fmt.Println(output.Dim("dry run: nothing was uploaded"))
				return nil
			}
			cl, _, err := client()
			if err != nil {
				return err
			}
			chosen := scan.Found
			if !yesFlag {
				if !term.IsTerminal(int(os.Stdin.Fd())) || !output.IsTTY() {
					return output.ErrPromptRefused
				}
				if chosen, err = pickClaudeItems(scan.Found); err != nil {
					return err
				}
			}
			if len(chosen) == 0 {
				output.Warnf("nothing selected")
				return nil
			}
			if len(chosen) > claudeMaxItems {
				return &exitcode.UsageError{Err: fmt.Errorf("%d items selected but one import takes at most %d; narrow it with --only or deselect some", len(chosen), claudeMaxItems)}
			}
			renderClaudeSummary(os.Stderr, chosen)
			items := make([]claudeImportItem, len(chosen))
			for i, f := range chosen {
				items[i] = f.Item
			}
			var out map[string]any
			if err := cl.Send(cmd.Context(), http.MethodPost, claudeContextPath+"/import", map[string]any{"items": items}, &out); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(out)
			}
			output.Successf("imported %s item(s) into your Orchard account", pick(out, "imported"))
			fmt.Println(output.Dim("see them with: orchard claude list"))
			return nil
		},
	}
	c.Flags().StringVar(&from, "from", "claude", "source to import from (only \"claude\")")
	c.Flags().StringVar(&dir, "dir", "", "Claude Code config directory (default ~/.claude)")
	c.Flags().BoolVar(&dryRun, "dry-run", false, "show what would be uploaded and exit")
	c.Flags().StringSliceVar(&only, "only", nil, "kinds to import: instructions,agent,command,skill,mcp")
	return c
}

func claudeListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List the Claude Code setup imported into your account",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), claudeContextPath, &raw); err != nil {
				return err
			}
			if fmtFlag() == output.FormatJSON {
				return output.JSON(raw)
			}
			rows := [][]string{}
			for _, e := range asList(raw) {
				enabled := "no"
				if b, _ := e["enabled"].(bool); b {
					enabled = "yes"
				}
				size, _ := e["sizeBytes"].(float64)
				rows = append(rows, []string{pick(e, "kind"), pick(e, "name"), enabled, quotaHumanBytes(size), pick(e, "updatedAt")})
			}
			if len(rows) == 0 {
				fmt.Println(output.Dim("Nothing imported yet. Run: orchard claude import"))
				return nil
			}
			output.Table([]string{"kind", "name", "enabled", "size", "updated"}, rows)
			return nil
		},
	}
}

func claudeRemoveCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "remove <kind>/<name>",
		Aliases: []string{"rm"},
		Short:   "Remove one imported item from your account",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			kind, name, ok := strings.Cut(args[0], "/")
			if !ok || kind == "" || name == "" {
				return &exitcode.UsageError{Err: fmt.Errorf("expected <kind>/<name>, e.g. agent/reviewer, got %q", args[0])}
			}
			name = strings.ReplaceAll(name, "/", ":")
			cl, _, err := client()
			if err != nil {
				return err
			}
			var raw map[string]any
			if err := cl.GetJSON(cmd.Context(), claudeContextPath, &raw); err != nil {
				return err
			}
			id := ""
			for _, e := range asList(raw) {
				if pick(e, "kind") == kind && pick(e, "name") == name {
					id = pick(e, "id")
					break
				}
			}
			if id == "" {
				return fmt.Errorf("no %s named %q (see: orchard claude list)", kind, name)
			}
			if err := output.Confirm(fmt.Sprintf("remove %s/%s from your Orchard account", kind, name), yesFlag); err != nil {
				return err
			}
			if err := cl.Send(cmd.Context(), http.MethodDelete, claudeContextPath+"/"+url.PathEscape(id), nil, nil); err != nil {
				return err
			}
			output.Successf("removed %s/%s", kind, name)
			return nil
		},
	}
}
