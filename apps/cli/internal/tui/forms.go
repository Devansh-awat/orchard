package tui

import (
	"context"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// result of a form submission's async command
type formResult struct {
	ok  tea.Msg
	err error
}

// finishForm pops the form, then delivers ok to the revealed parent screen.
func finishForm(ok tea.Msg) tea.Cmd {
	return tea.Sequence(func() tea.Msg { return popScreen{} }, func() tea.Msg { return ok })
}

type field struct {
	key, label string
	required   bool
	ti         textinput.Model
}

func fld(key, label, placeholder string, required bool) *field {
	ti := textinput.New()
	ti.Placeholder = placeholder
	ti.Prompt = ""
	ti.CharLimit = 512
	return &field{key: key, label: label, required: required, ti: ti}
}

type formScreen struct {
	heading string
	hint    string
	fields  []*field
	focus   int
	submit  func(map[string]string) tea.Cmd
	errText string
	busy    bool
	w, h    int
}

func newForm(heading, hint string, fields []*field, submit func(map[string]string) tea.Cmd) *formScreen {
	f := &formScreen{heading: heading, hint: hint, fields: fields, submit: submit}
	if len(fields) > 0 {
		fields[0].ti.Focus()
	}
	return f
}

func (s *formScreen) title() string { return s.heading }

func (s *formScreen) help() []keyHint {
	return []keyHint{{"enter", "next"}, {"ctrl+s", "submit"}, {"esc", "cancel"}}
}

func (s *formScreen) Init() tea.Cmd { return textinput.Blink }

func (s *formScreen) setFocus(i int) {
	s.fields[s.focus].ti.Blur()
	s.focus = (i + len(s.fields)) % len(s.fields)
	s.fields[s.focus].ti.Focus()
}

func (s *formScreen) doSubmit() (screen, tea.Cmd) {
	vals := map[string]string{}
	for _, f := range s.fields {
		v := strings.TrimSpace(f.ti.Value())
		if f.required && v == "" {
			s.errText = f.label + " is required"
			return s, nil
		}
		vals[f.key] = v
	}
	s.busy, s.errText = true, ""
	return s, s.submit(vals)
}

func (s *formScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case formResult:
		s.busy = false
		if msg.err != nil {
			s.errText = msg.err.Error()
			return s, nil
		}
		return s, finishForm(msg.ok)
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "tab", "down":
			s.setFocus(s.focus + 1)
			return s, nil
		case "shift+tab", "up":
			s.setFocus(s.focus - 1)
			return s, nil
		case "ctrl+s":
			return s.doSubmit()
		case "enter":
			if s.focus == len(s.fields)-1 {
				return s.doSubmit()
			}
			s.setFocus(s.focus + 1)
			return s, nil
		}
	}
	var cmd tea.Cmd
	s.fields[s.focus].ti, cmd = s.fields[s.focus].ti.Update(msg)
	return s, cmd
}

func (s *formScreen) View() string {
	var b strings.Builder
	b.WriteString("\n  " + stTitle.Render(s.heading) + "\n\n")
	for i, f := range s.fields {
		label := stMuted.Render(f.label)
		if i == s.focus {
			label = stAccent.Render(f.label)
		}
		b.WriteString("  " + label + "\n" + boxedInput(f.ti.View(), i == s.focus, s.w) + "\n\n")
	}
	if s.hint != "" {
		b.WriteString("  " + stMuted.Render(s.hint) + "\n")
	}
	if s.errText != "" {
		b.WriteString("  " + stRed.Render("✗ "+s.errText) + "\n")
	}
	status := "enter next · ctrl+s submit · esc cancel"
	if s.busy {
		status = "submitting…"
	}
	b.WriteString("\n  " + stFooter.Render(status))
	return b.String()
}

// ---- concrete forms ----

type createdMsg struct{ text string }

func newDeployFormImage(cl *api.Client, p Project) *formScreen {
	return newForm("New deployment (image)",
		"Deploys a container image directly.",
		[]*field{
			fld("name", "Name", "my-service", true),
			fld("image", "Image", "nginx:latest", true),
			fld("port", "Port", "80", false),
			fld("replicas", "Replicas", "1", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"name": v["name"], "image": v["image"]}
				if n, err := strconv.Atoi(v["port"]); err == nil {
					body["port"] = n
				}
				if n, err := strconv.Atoi(v["replicas"]); err == nil {
					body["replicas"] = n
				}
				err := cl.Send(context.Background(), "POST", "/projects/"+p.ID+"/deployments", body, nil)
				return formResult{ok: createdMsg{"created deployment " + v["name"]}, err: err}
			}
		})
}

func newDeployFormGithub(cl *api.Client, p Project) *formScreen {
	return newForm("New deployment (GitHub)",
		"Builds and deploys from a GitHub repo.",
		[]*field{
			fld("name", "Name", "my-app", true),
			fld("repoUrl", "Repo", "owner/repo or https URL", true),
			fld("branch", "Branch", "main", false),
			fld("dockerfilePath", "Dockerfile", "Dockerfile", false),
			fld("target", "Build stage", "final stage", false),
			fld("port", "Port", "80", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"name": v["name"], "repoUrl": v["repoUrl"]}
				if v["branch"] != "" {
					body["branch"] = v["branch"]
				}
				if v["dockerfilePath"] != "" {
					body["dockerfilePath"] = v["dockerfilePath"]
				}
				if v["target"] != "" {
					body["target"] = v["target"]
				}
				if n, err := strconv.Atoi(v["port"]); err == nil {
					body["port"] = n
				}
				err := cl.Send(context.Background(), "POST", "/projects/"+p.ID+"/deployments/from-github", body, nil)
				return formResult{ok: createdMsg{"building deployment " + v["name"]}, err: err}
			}
		})
}

func newDatabaseFormScreen(cl *api.Client, p Project) *formScreen {
	return newForm("New database",
		"Provisions a Postgres database in this project.",
		[]*field{
			fld("name", "Name", "main", true),
			fld("storageSize", "Storage", "1Gi", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"name": v["name"]}
				if v["storageSize"] != "" {
					body["storageSize"] = v["storageSize"]
				}
				err := cl.Send(context.Background(), "POST", "/projects/"+p.ID+"/databases", body, nil)
				return formResult{ok: createdMsg{"creating database " + v["name"]}, err: err}
			}
		})
}

func newScaleScreen(cl *api.Client, depID string, current int) *formScreen {
	f := fld("replicas", "Replicas", strconv.Itoa(current), true)
	f.ti.SetValue(strconv.Itoa(current))
	return newForm("Scale deployment",
		"Set the desired number of replicas.",
		[]*field{f},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				n, err := strconv.Atoi(v["replicas"])
				if err != nil {
					return formResult{err: errInvalid("replicas must be a number")}
				}
				err = cl.Send(context.Background(), "POST", "/deployments/"+depID+"/scale", map[string]any{"replicas": n}, nil)
				return formResult{ok: actionMsg{text: "scaled to " + v["replicas"]}, err: err}
			}
		})
}

type strErr string

func (e strErr) Error() string  { return string(e) }
func errInvalid(s string) error { return strErr(s) }
