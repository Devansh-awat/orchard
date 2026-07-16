package tui

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

// jobRunPoll is the fast cadence while a run is active — step logs move fast.
const jobRunPoll = 2 * time.Second

type (
	jobRunMsg struct {
		r   *JobRun
		err error
	}
	stepLogsMsg struct {
		runID     string
		order     int
		logs      string
		truncated bool
		live      bool
		err       error
	}
)

func jobRunPath(id string, rest ...string) string {
	p := "/job-runs/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

func fetchJobRun(cl *api.Client, runID string) tea.Cmd {
	return func() tea.Msg {
		var r JobRun
		if err := cl.GetJSON(context.Background(), jobRunPath(runID), &r); err != nil {
			return jobRunMsg{nil, err}
		}
		return jobRunMsg{&r, nil}
	}
}

func fetchStepLogs(cl *api.Client, runID string, order int) tea.Cmd {
	return func() tea.Msg {
		var raw struct {
			Logs      string `json:"logs"`
			Truncated bool   `json:"truncated"`
			Live      bool   `json:"live"`
		}
		err := cl.GetJSON(context.Background(),
			jobRunPath(runID, "steps", strconv.Itoa(order), "logs"), &raw)
		return stepLogsMsg{runID, order, raw.Logs, raw.Truncated, raw.Live, err}
	}
}

func cancelJobRunCmd(cl *api.Client, runID string, number int) tea.Cmd {
	return doAction(cl, "POST", jobRunPath(runID, "cancel"), map[string]any{},
		fmt.Sprintf("cancelled run #%d", number))
}

// jobRunScreen shows one run: the step pipeline on top, the selected step's
// live logs below.
type jobRunScreen struct {
	cl      *api.Client
	org     string
	jobName string
	runID   string

	run     *JobRun
	stepSel int
	autoSel bool
	logVP   viewport.Model
	confirm confirmModel
	loading bool
	tickGen int
	w, h    int
}

func newJobRunScreen(cl *api.Client, org, jobName, runID string) *jobRunScreen {
	return &jobRunScreen{cl: cl, org: org, jobName: jobName, runID: runID, loading: true}
}

func (s *jobRunScreen) orgID() string { return s.org }

func (s *jobRunScreen) title() string {
	if s.run != nil {
		return fmt.Sprintf("%s #%d", firstNonEmpty(s.run.JobName, s.jobName, "run"), s.run.Number)
	}
	return firstNonEmpty(s.jobName, "run")
}

func (s *jobRunScreen) Init() tea.Cmd { return fetchJobRun(s.cl, s.runID) }

func (s *jobRunScreen) active() bool {
	return s.run == nil || runActiveStatus(s.run.Status)
}

func (s *jobRunScreen) tick() tea.Cmd {
	gen := s.tickGen
	return tea.Tick(jobRunPoll, func(time.Time) tea.Msg { return tickMsg{"jobrun:" + s.runID, gen} })
}

// OnOrgEvent refetches the run the moment the bus reports it changed.
func (s *jobRunScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	if ev.Type == "jobrun.changed" && ev.ID == s.runID {
		return fetchJobRun(s.cl, s.runID)
	}
	return nil
}

func (s *jobRunScreen) selStep() *JobRunStep {
	if s.run == nil || s.stepSel < 0 || s.stepSel >= len(s.run.Steps) {
		return nil
	}
	return &s.run.Steps[s.stepSel]
}

// loadSelLogs fetches the selected step's logs, or renders a placeholder for
// steps that never produced any.
func (s *jobRunScreen) loadSelLogs() tea.Cmd {
	st := s.selStep()
	if st == nil {
		return nil
	}
	switch lc(st.Status) {
	case "pending", "":
		s.logVP.SetContent(stMuted.Render("(waiting to start)"))
		return nil
	case "skipped":
		s.logVP.SetContent(stMuted.Render("(skipped)"))
		return nil
	}
	return fetchStepLogs(s.cl, s.runID, st.StepOrder)
}

func (s *jobRunScreen) setStep(i int) tea.Cmd {
	if s.run == nil || i < 0 || i >= len(s.run.Steps) || i == s.stepSel {
		return nil
	}
	s.stepSel = i
	s.logVP.SetContent(stMuted.Render("loading logs…"))
	return s.loadSelLogs()
}

func (s *jobRunScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.logVP.Width = s.w - 4
		s.logVP.Height = max(s.h-chromeH-10, 3)
	case tickMsg:
		if msg.id == "jobrun:"+s.runID && msg.gen == s.tickGen {
			return s, fetchJobRun(s.cl, s.runID)
		}
	case jobRunMsg:
		s.loading = false
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		s.run = msg.r
		if !s.autoSel && len(s.run.Steps) > 0 {
			// auto-focus the interesting step: running, else first failure
			for i, st := range s.run.Steps {
				if lc(st.Status) == "running" {
					s.stepSel = i
					break
				}
			}
			if lc(s.run.Steps[s.stepSel].Status) != "running" {
				for i, st := range s.run.Steps {
					if lc(st.Status) == "failed" || lc(st.Status) == "timed_out" {
						s.stepSel = i
						break
					}
				}
			}
			s.autoSel = true
		}
		if s.stepSel >= len(s.run.Steps) {
			s.stepSel = 0
		}
		cmds := []tea.Cmd{s.loadSelLogs()}
		if s.active() {
			s.tickGen++ // supersede any in-flight tick so chains never stack
			cmds = append(cmds, s.tick())
		}
		return s, tea.Batch(cmds...)
	case stepLogsMsg:
		if msg.runID != s.runID {
			return s, nil
		}
		st := s.selStep()
		if st == nil || st.StepOrder != msg.order {
			return s, nil
		}
		if msg.err != nil {
			s.logVP.SetContent(stRed.Render("✗ " + msg.err.Error()))
			return s, nil
		}
		content := msg.logs
		if strings.TrimSpace(content) == "" {
			content = stMuted.Render("(no output yet)")
		}
		if msg.truncated {
			content = stYellow.Render("… logs truncated") + "\n" + content
		}
		s.logVP.SetContent(content)
		s.logVP.GotoBottom()
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(fetchJobRun(s.cl, s.runID), flashf("%s", msg.text))
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			s.logVP.LineUp(2)
		case tea.MouseButtonWheelDown:
			s.logVP.LineDown(2)
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "up":
			return s, s.setStep(s.stepSel - 1)
		case "down":
			return s, s.setStep(s.stepSel + 1)
		case "k":
			s.logVP.LineUp(1)
		case "j":
			s.logVP.LineDown(1)
		case "pgup":
			s.logVP.HalfViewUp()
		case "pgdown":
			s.logVP.HalfViewDown()
		case "r":
			return s, fetchJobRun(s.cl, s.runID)
		case "c":
			if s.run != nil && runActiveStatus(s.run.Status) {
				s.confirm.Show(fmt.Sprintf("Cancel run #%d? Remaining steps are skipped.", s.run.Number),
					cancelJobRunCmd(s.cl, s.runID, s.run.Number))
			}
		}
	}
	return s, nil
}

func (s *jobRunScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	hints := []keyHint{{"↑/↓", "step"}, {"j/k", "scroll"}}
	if s.run != nil && runActiveStatus(s.run.Status) {
		hints = append(hints, keyHint{"c", "cancel"})
	}
	return append(hints, keyHint{"r", "refresh"}, keyHint{"esc", "back"})
}

func (s *jobRunScreen) View() string {
	return s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
}

func (s *jobRunScreen) view() string {
	if s.run == nil {
		return stMuted.Render("\n  loading run…")
	}
	r := s.run
	bodyH := s.h - chromeH

	var top strings.Builder
	trigger := r.Trigger
	if r.Trigger == "cron" {
		trigger = "schedule"
	} else if r.TriggeredBy != nil && r.TriggeredBy.Name != "" {
		trigger = "manual · " + r.TriggeredBy.Name
	}
	meta := badge(r.Status) + "  " + stMuted.Render(trigger)
	if r.StartedAt != "" {
		meta += stMuted.Render(" · started " + relWhen(r.StartedAt))
	}
	if d := runDur(r.StartedAt, r.FinishedAt); d != "" {
		meta += "  " + stKey.Render(d)
	}
	top.WriteString(meta + "\n")
	extraLines := 0
	if r.ErrorMessage != "" {
		top.WriteString(stRed.Render("✗ "+r.ErrorMessage) + "\n")
		extraLines++
	}
	top.WriteString("\n")

	nameW := 0
	for _, st := range r.Steps {
		if len(st.Name) > nameW {
			nameW = len(st.Name)
		}
	}
	for i, st := range r.Steps {
		line := runMark(st.Status) + " " + pad(st.Name, nameW) + "  " + runStatusDot(st.Status)
		if d := runDur(st.StartedAt, st.FinishedAt); d != "" {
			line += stMuted.Render("  " + d)
		}
		if st.ExitCode != nil && *st.ExitCode != 0 {
			line += stRed.Render(fmt.Sprintf("  exit=%d", *st.ExitCode))
		}
		if st.Reason != "" {
			line += stMuted.Render("  " + st.Reason)
		}
		if i == s.stepSel {
			top.WriteString(stSelBar.Render("▌") + " " + line + "\n")
		} else {
			top.WriteString("  " + line + "\n")
		}
	}

	topH := len(r.Steps) + 4 + extraLines
	if topH > bodyH-5 {
		topH = max(bodyH-5, 3)
	}
	logsH := bodyH - topH
	s.logVP.Width = s.w - 4
	s.logVP.Height = max(logsH-2, 1)
	if s.logVP.PastBottom() {
		s.logVP.GotoBottom()
	}

	title := "Logs"
	if st := s.selStep(); st != nil {
		title = fmt.Sprintf("Logs — step %d: %s", st.StepOrder, st.Name)
	}
	head := panel(fmt.Sprintf("Run #%d", r.Number), top.String(), s.w, topH, false)
	logs := panelRaw(stTabSel.Render(title), s.logVP.View(), s.w, logsH, true)
	return head + "\n" + logs
}
