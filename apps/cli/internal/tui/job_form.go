package tui

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/api"
)

// step kinds: the type cycler folds the script runtime into the choice, like
// the frontend's Script/App/Image tabs + runtime dropdown collapsed into one.
var stepKinds = []struct{ label, typ, runtime string }{
	{"script · bash", "script", "bash"},
	{"script · python", "script", "python"},
	{"script · node", "script", "node"},
	{"app command", "app", ""},
	{"custom image", "image", ""},
}

const (
	kindApp   = 3
	kindImage = 4
)

func kindFor(typ, runtime string) int {
	for i, k := range stepKinds {
		if k.typ == typ && (typ != "script" || k.runtime == runtime) {
			return i
		}
	}
	return 0
}

// cron presets mirror the frontend CronScheduleField (utils/cron.ts).
var cronPresets = []struct{ label, value string }{
	{"manual only", ""},
	{"every 15 minutes", "*/15 * * * *"},
	{"every hour", "0 * * * *"},
	{"daily at 02:00", "0 2 * * *"},
	{"weekly (Sun 02:00)", "0 2 * * 0"},
	{"monthly (1st 02:00)", "0 2 1 * *"},
	{"custom cron…", "custom"},
}

func schedCustom() int { return len(cronPresets) - 1 }

func schedIdxFor(cron string) int {
	if cron == "" {
		return 0
	}
	for i, p := range cronPresets {
		if p.value == cron {
			return i
		}
	}
	return schedCustom()
}

// stepDraft is one step's editable widget set.
type stepDraft struct {
	name   textinput.Model
	kind   int
	image  textinput.Model
	depIdx int
	depID  string // seeded id, resolved to depIdx once deployments load
	body   textarea.Model
	env    textarea.Model

	// advanced fields preserved verbatim on edit (no TUI editor for them)
	timeoutSeconds int
	retries        int
	cpuMilli       float64
	memBytes       float64
}

func formTA(placeholder string, height int) textarea.Model {
	ta := textarea.New()
	ta.Placeholder = placeholder
	ta.ShowLineNumbers = false
	ta.Prompt = stMuted.Render("│ ")
	ta.CharLimit = 0
	ta.SetHeight(height)
	blank := lipgloss.NewStyle()
	ta.FocusedStyle.Base = blank
	ta.FocusedStyle.CursorLine = blank
	ta.FocusedStyle.EndOfBuffer = stMuted
	ta.FocusedStyle.Text = stInputOn
	ta.FocusedStyle.Placeholder = stMuted
	ta.BlurredStyle.Base = blank
	ta.BlurredStyle.CursorLine = blank
	ta.BlurredStyle.EndOfBuffer = stMuted
	ta.BlurredStyle.Text = stInputOn
	ta.BlurredStyle.Placeholder = stMuted
	return ta
}

func formTI(placeholder string) textinput.Model {
	ti := textinput.New()
	ti.Placeholder = placeholder
	ti.Prompt = ""
	return ti
}

func newStepDraft(n int) *stepDraft {
	return &stepDraft{
		name:  formTI(fmt.Sprintf("Step %d", n)),
		image: formTI("ghcr.io/acme/tool:latest"),
		body:  formTA("echo hello", 4),
		env:   formTA("KEY=value (one per line)", 3),
	}
}

func draftFromStep(st JobStep) *stepDraft {
	d := newStepDraft(st.StepOrder)
	d.name.SetValue(st.Name)
	d.kind = kindFor(st.Type, st.ScriptRuntime)
	d.depID = st.DeploymentID
	d.image.SetValue(st.Image)
	if st.Type == "script" {
		d.body.SetValue(st.Script)
	} else {
		d.body.SetValue(st.Command)
	}
	lines := make([]string, 0, len(st.EnvVars))
	for _, e := range st.EnvVars {
		lines = append(lines, e.Key+"="+e.Value)
	}
	d.env.SetValue(strings.Join(lines, "\n"))
	d.timeoutSeconds = st.TimeoutSeconds
	d.retries = st.Retries
	d.cpuMilli = float64(st.CPUMilli)
	d.memBytes = float64(st.MemoryRequestB)
	return d
}

// jfRef addresses one focusable field: step == -1 → job-level field
// (0 name, 1 description, 2 schedule cycler, 3 custom cron, 4 timezone);
// step >= 0 → step field (0 name, 1 kind, 2 target, 3 script/command, 4 env).
type jfRef struct{ step, field int }

// jobForm creates or edits a job at frontend JobForm parity: details, cron
// trigger with presets, timezone, and a full steps editor.
type jobForm struct {
	cl        *api.Client
	projectID string
	editID    string

	name       textinput.Model
	desc       textinput.Model
	schedIdx   int
	cronCustom textinput.Model
	tz         textinput.Model
	steps      []*stepDraft
	deps       []Deployment

	focus   int
	errText string
	busy    bool
	w, h    int
}

// newJobFormScreen builds the create form (job == nil) or the edit form
// seeded from an existing job (steps included).
func newJobFormScreen(cl *api.Client, projectID string, job *Job) *jobForm {
	s := &jobForm{
		cl:         cl,
		projectID:  projectID,
		name:       formTI("nightly-cleanup"),
		desc:       formTI("optional description"),
		cronCustom: formTI("0 2 * * *"),
		tz:         formTI("UTC (IANA name, optional)"),
	}
	if job != nil {
		s.editID = job.ID
		s.name.SetValue(job.Name)
		s.desc.SetValue(job.Description)
		s.schedIdx = schedIdxFor(job.ScheduleCron)
		if s.schedIdx == schedCustom() {
			s.cronCustom.SetValue(job.ScheduleCron)
		}
		s.tz.SetValue(job.TimeZone)
		for _, st := range job.Steps {
			s.steps = append(s.steps, draftFromStep(st))
		}
	}
	if len(s.steps) == 0 {
		s.steps = append(s.steps, newStepDraft(1))
	}
	s.applyFocus()
	return s
}

func (s *jobForm) heading() string {
	if s.editID != "" {
		return "Edit job"
	}
	return "New job"
}

func (s *jobForm) title() string { return s.heading() }

func (s *jobForm) help() []keyHint {
	return []keyHint{{"tab", "next"}, {"←/→", "cycle"}, {"ctrl+n", "add step"},
		{"ctrl+x", "del step"}, {"ctrl+j/k", "move step"}, {"ctrl+s", "save"}, {"esc", "cancel"}}
}

func (s *jobForm) Init() tea.Cmd {
	cmds := []tea.Cmd{textinput.Blink}
	if s.projectID != "" {
		cmds = append(cmds, fetchDeployments(s.cl, s.projectID))
	}
	return tea.Batch(cmds...)
}

func (s *jobForm) frefs() []jfRef {
	out := []jfRef{{-1, 0}, {-1, 1}, {-1, 2}}
	if s.schedIdx == schedCustom() {
		out = append(out, jfRef{-1, 3})
	}
	out = append(out, jfRef{-1, 4})
	for i, d := range s.steps {
		out = append(out, jfRef{i, 0}, jfRef{i, 1})
		if d.kind == kindApp || d.kind == kindImage {
			out = append(out, jfRef{i, 2})
		}
		out = append(out, jfRef{i, 3}, jfRef{i, 4})
	}
	return out
}

func (s *jobForm) cur() jfRef {
	refs := s.frefs()
	if s.focus >= len(refs) {
		s.focus = len(refs) - 1
	}
	return refs[s.focus]
}

func (s *jobForm) applyFocus() {
	s.name.Blur()
	s.desc.Blur()
	s.cronCustom.Blur()
	s.tz.Blur()
	for _, d := range s.steps {
		d.name.Blur()
		d.image.Blur()
		d.body.Blur()
		d.env.Blur()
	}
	ref := s.cur()
	if ref.step == -1 {
		switch ref.field {
		case 0:
			s.name.Focus()
		case 1:
			s.desc.Focus()
		case 3:
			s.cronCustom.Focus()
		case 4:
			s.tz.Focus()
		}
		return
	}
	d := s.steps[ref.step]
	switch ref.field {
	case 0:
		d.name.Focus()
	case 2:
		if d.kind == kindImage {
			d.image.Focus()
		}
	case 3:
		d.body.Focus()
	case 4:
		d.env.Focus()
	}
}

func (s *jobForm) move(delta int) {
	n := len(s.frefs())
	s.focus = (s.focus + delta + n) % n
	s.applyFocus()
}

func (s *jobForm) focusOn(ref jfRef) {
	for i, r := range s.frefs() {
		if r == ref {
			s.focus = i
			break
		}
	}
	s.applyFocus()
}

func (s *jobForm) curIsTextarea() bool {
	ref := s.cur()
	return ref.step >= 0 && (ref.field == 3 || ref.field == 4)
}

// cycle turns ←/→ into value changes on the cycler fields; false means the
// key belongs to the focused text widget instead.
func (s *jobForm) cycle(fwd bool) bool {
	d := 1
	if !fwd {
		d = -1
	}
	ref := s.cur()
	if ref.step == -1 && ref.field == 2 {
		s.schedIdx = (s.schedIdx + d + len(cronPresets)) % len(cronPresets)
		return true
	}
	if ref.step >= 0 && ref.field == 1 {
		sd := s.steps[ref.step]
		sd.kind = (sd.kind + d + len(stepKinds)) % len(stepKinds)
		return true
	}
	if ref.step >= 0 && ref.field == 2 && s.steps[ref.step].kind == kindApp {
		if len(s.deps) > 0 {
			sd := s.steps[ref.step]
			sd.depIdx = (sd.depIdx + d + len(s.deps)) % len(s.deps)
		}
		return true
	}
	return false
}

func (s *jobForm) addStep() {
	s.steps = append(s.steps, newStepDraft(len(s.steps)+1))
	s.sizeWidgets()
	s.focusOn(jfRef{len(s.steps) - 1, 0})
}

func (s *jobForm) removeStep() {
	ref := s.cur()
	if ref.step < 0 || len(s.steps) == 0 {
		return
	}
	s.steps = append(s.steps[:ref.step], s.steps[ref.step+1:]...)
	if len(s.steps) == 0 {
		s.focusOn(jfRef{-1, 0})
		return
	}
	s.focusOn(jfRef{min(ref.step, len(s.steps)-1), 0})
}

func (s *jobForm) moveStep(delta int) {
	ref := s.cur()
	if ref.step < 0 {
		return
	}
	j := ref.step + delta
	if j < 0 || j >= len(s.steps) {
		return
	}
	s.steps[ref.step], s.steps[j] = s.steps[j], s.steps[ref.step]
	s.focusOn(jfRef{j, ref.field})
}

func (s *jobForm) cronValue() string {
	if s.schedIdx == schedCustom() {
		return strings.TrimSpace(s.cronCustom.Value())
	}
	return cronPresets[s.schedIdx].value
}

// stepPayload builds the steps array with the exact field names the API (and
// `orchard job create --steps`) uses.
func (s *jobForm) stepPayload() ([]map[string]any, error) {
	if len(s.steps) == 0 {
		return nil, errInvalid("add at least one step (ctrl+n)")
	}
	out := make([]map[string]any, len(s.steps))
	for i, d := range s.steps {
		k := stepKinds[d.kind]
		name := strings.TrimSpace(d.name.Value())
		if name == "" {
			name = fmt.Sprintf("Step %d", i+1)
		}
		m := map[string]any{"name": name, "type": k.typ}
		body := strings.TrimSpace(d.body.Value())
		switch k.typ {
		case "script":
			if body == "" {
				return nil, errInvalid(fmt.Sprintf("step %d: script is required", i+1))
			}
			m["script"] = body
			m["scriptRuntime"] = k.runtime
		case "app":
			if len(s.deps) == 0 {
				return nil, errInvalid(fmt.Sprintf("step %d: this project has no apps to run against", i+1))
			}
			if body == "" {
				return nil, errInvalid(fmt.Sprintf("step %d: command is required", i+1))
			}
			m["deploymentId"] = s.deps[min(d.depIdx, len(s.deps)-1)].ID
			m["command"] = body
		case "image":
			img := strings.TrimSpace(d.image.Value())
			if img == "" {
				return nil, errInvalid(fmt.Sprintf("step %d: image is required", i+1))
			}
			m["image"] = img
			if body != "" {
				m["command"] = body
			}
		}
		if env := parseEnv(d.env.Value()); len(env) > 0 {
			m["envVars"] = env
		}
		if d.timeoutSeconds > 0 {
			m["timeoutSeconds"] = d.timeoutSeconds
		}
		if d.retries > 0 {
			m["retries"] = d.retries
		}
		if d.cpuMilli > 0 {
			m["cpuRequestMilli"] = d.cpuMilli
		}
		if d.memBytes > 0 {
			m["memoryRequestBytes"] = d.memBytes
		}
		out[i] = m
	}
	return out, nil
}

func (s *jobForm) submit() (screen, tea.Cmd) {
	name := strings.TrimSpace(s.name.Value())
	if name == "" {
		s.errText = "name is required"
		return s, nil
	}
	cron := s.cronValue()
	if s.schedIdx == schedCustom() && cron == "" {
		s.errText = "enter a cron expression, or pick a preset"
		return s, nil
	}
	steps, err := s.stepPayload()
	if err != nil {
		s.errText = err.Error()
		return s, nil
	}
	desc := strings.TrimSpace(s.desc.Value())
	tz := strings.TrimSpace(s.tz.Value())
	s.busy, s.errText = true, ""
	cl, pid, editID := s.cl, s.projectID, s.editID
	return s, func() tea.Msg {
		if editID == "" {
			body := map[string]any{"name": name, "steps": steps}
			if cron != "" {
				body["scheduleCron"] = cron
			}
			if desc != "" {
				body["description"] = desc
			}
			if tz != "" {
				body["timeZone"] = tz
			}
			err := cl.Send(context.Background(), "POST",
				"/projects/"+url.PathEscape(pid)+"/jobs", body, nil)
			return formResult{ok: createdMsg{"created job " + name}, err: err}
		}
		patch := map[string]any{"name": name}
		if cron != "" {
			patch["scheduleCron"] = cron
		} else {
			patch["scheduleCron"] = nil
		}
		if desc != "" {
			patch["description"] = desc
		} else {
			patch["description"] = nil
		}
		if tz != "" {
			patch["timeZone"] = tz
		}
		if err := cl.Send(context.Background(), "PATCH", jobPath(editID), patch, nil); err != nil {
			return formResult{err: err}
		}
		err := cl.Send(context.Background(), "PUT", jobPath(editID, "steps"),
			map[string]any{"steps": steps}, nil)
		return formResult{ok: createdMsg{"updated job " + name}, err: err}
	}
}

func (s *jobForm) sizeWidgets() {
	w := min(max(s.w-10, 20), 68)
	for _, d := range s.steps {
		d.body.SetWidth(w)
		d.env.SetWidth(w)
	}
}

func (s *jobForm) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.sizeWidgets()
	case deploymentsMsg:
		if msg.err == nil {
			s.deps = msg.items
			for _, d := range s.steps {
				if d.depID == "" {
					continue
				}
				for i, dep := range s.deps {
					if dep.ID == d.depID {
						d.depIdx = i
						break
					}
				}
			}
		}
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
		case "ctrl+s":
			return s.submit()
		case "tab":
			s.move(1)
			return s, nil
		case "shift+tab":
			s.move(-1)
			return s, nil
		case "ctrl+n":
			s.addStep()
			return s, nil
		case "ctrl+x":
			s.removeStep()
			return s, nil
		case "ctrl+j":
			s.moveStep(1)
			return s, nil
		case "ctrl+k":
			s.moveStep(-1)
			return s, nil
		case "left", "right":
			if s.cycle(msg.String() == "right") {
				return s, nil
			}
		case "enter":
			if !s.curIsTextarea() {
				s.move(1)
				return s, nil
			}
		case "up":
			if !s.curIsTextarea() {
				s.move(-1)
				return s, nil
			}
		case "down":
			if !s.curIsTextarea() {
				s.move(1)
				return s, nil
			}
		}
	}
	return s, s.routeToFocused(msg)
}

// routeToFocused delivers msg to whichever text widget currently has focus.
func (s *jobForm) routeToFocused(msg tea.Msg) tea.Cmd {
	ref := s.cur()
	var cmd tea.Cmd
	if ref.step == -1 {
		switch ref.field {
		case 0:
			s.name, cmd = s.name.Update(msg)
		case 1:
			s.desc, cmd = s.desc.Update(msg)
		case 3:
			s.cronCustom, cmd = s.cronCustom.Update(msg)
		case 4:
			s.tz, cmd = s.tz.Update(msg)
		}
		return cmd
	}
	d := s.steps[ref.step]
	switch ref.field {
	case 0:
		d.name, cmd = d.name.Update(msg)
	case 2:
		if d.kind == kindImage {
			d.image, cmd = d.image.Update(msg)
		}
	case 3:
		d.body, cmd = d.body.Update(msg)
	case 4:
		d.env, cmd = d.env.Update(msg)
	}
	return cmd
}

func cyclerView(value string, focused bool, hint string) string {
	v := stInputOn.Render(value)
	if focused {
		v = stAccent.Render(value)
	}
	out := "  " + stMuted.Render("‹ ") + v + stMuted.Render(" ›")
	if focused && hint != "" {
		out += stMuted.Render("   " + hint)
	}
	return out
}

func (s *jobForm) View() string {
	cur := s.cur()
	var b strings.Builder
	focusLine := 0
	mark := func(is bool) {
		if is {
			focusLine = strings.Count(b.String(), "\n")
		}
	}
	label := func(text string, is bool) string {
		if is {
			return stAccent.Render(text)
		}
		return stMuted.Render(text)
	}

	b.WriteString("\n  " + stTitle.Render(s.heading()) + "\n\n")

	is := cur == jfRef{-1, 0}
	mark(is)
	b.WriteString("  " + label("Name", is) + "\n" + boxedInput(s.name.View(), is, s.w) + "\n")

	is = cur == jfRef{-1, 1}
	mark(is)
	b.WriteString("  " + label("Description", is) + "\n" + boxedInput(s.desc.View(), is, s.w) + "\n")

	is = cur == jfRef{-1, 2}
	mark(is)
	b.WriteString("  " + label("Schedule", is) + "\n" +
		cyclerView(cronPresets[s.schedIdx].label, is, "(←/→ to change)") + "\n")
	if s.schedIdx == schedCustom() {
		is = cur == jfRef{-1, 3}
		mark(is)
		b.WriteString("  " + label("Cron expression (5 fields)", is) + "\n" +
			boxedInput(s.cronCustom.View(), is, s.w) + "\n")
	} else if s.schedIdx > 0 {
		b.WriteString("  " + stMuted.Render("cron: "+cronPresets[s.schedIdx].value) + "\n")
	}

	is = cur == jfRef{-1, 4}
	mark(is)
	b.WriteString("  " + label("Timezone", is) + "\n" + boxedInput(s.tz.View(), is, s.w) + "\n")

	b.WriteString("\n  " + stTitle.Render("Steps") + " " +
		stMuted.Render("steps run in order, and a failure stops the rest") + "\n\n")

	for i, d := range s.steps {
		active := cur.step == i
		rule := fmt.Sprintf("Step %d ", i+1)
		st := stMuted
		if active {
			st = stAccent
		}
		b.WriteString("  " + st.Render(rule+strings.Repeat("─", max(30-len(rule), 0))) + "\n")

		is = cur == jfRef{i, 0}
		mark(is)
		b.WriteString("  " + label("Name", is) + "\n" + boxedInput(d.name.View(), is, s.w) + "\n")

		is = cur == jfRef{i, 1}
		mark(is)
		b.WriteString("  " + label("Type", is) + "\n" +
			cyclerView(stepKinds[d.kind].label, is, "(←/→ to change)") + "\n")

		switch d.kind {
		case kindApp:
			is = cur == jfRef{i, 2}
			mark(is)
			depName := "(no apps in project)"
			if len(s.deps) > 0 {
				depName = s.deps[min(d.depIdx, len(s.deps)-1)].Name
			}
			b.WriteString("  " + label("App", is) + "\n" + cyclerView(depName, is, "(←/→ to change)") + "\n")
		case kindImage:
			is = cur == jfRef{i, 2}
			mark(is)
			b.WriteString("  " + label("Image", is) + "\n" + boxedInput(d.image.View(), is, s.w) + "\n")
		}

		bodyLabel := "Script"
		if d.kind >= kindApp {
			bodyLabel = "Command"
		}
		is = cur == jfRef{i, 3}
		mark(is)
		b.WriteString("  " + label(bodyLabel, is) + "\n" + indentBlock(d.body.View()) + "\n")

		is = cur == jfRef{i, 4}
		mark(is)
		envLabel := "Env vars"
		if d.kind == kindApp {
			envLabel = "Env overrides"
		}
		b.WriteString("  " + label(envLabel, is) + "\n" + indentBlock(d.env.View()) + "\n")
	}

	if s.errText != "" {
		b.WriteString("  " + stRed.Render("✗ "+s.errText) + "\n")
	}
	status := "tab next · ←/→ cycle · ctrl+n add step · ctrl+s save · esc cancel"
	if s.busy {
		status = "saving…"
	}
	b.WriteString("\n  " + stFooter.Render(status))

	// keep the focused field on screen: window the rendered lines around it
	lines := strings.Split(b.String(), "\n")
	bodyH := s.h - chromeH
	if bodyH > 0 && len(lines) > bodyH {
		start := focusLine - bodyH/2
		if start < 0 {
			start = 0
		}
		if start > len(lines)-bodyH {
			start = len(lines) - bodyH
		}
		lines = lines[start : start+bodyH]
	}
	return strings.Join(lines, "\n")
}

func indentBlock(v string) string {
	out := make([]string, 0, 8)
	for _, ln := range strings.Split(v, "\n") {
		out = append(out, "  "+ln)
	}
	return strings.Join(out, "\n")
}
