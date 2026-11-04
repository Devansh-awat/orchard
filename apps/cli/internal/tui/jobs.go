package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/hackclub/orchard/cli/internal/api"
)

// JobRunRef is the compact run shape embedded in job list/detail responses
// (lastRun / recentRuns).
type JobRunRef struct {
	ID         string `json:"id"`
	Number     int    `json:"number"`
	Status     string `json:"status"`
	Trigger    string `json:"trigger"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	CreatedAt  string `json:"createdAt"`
}

type JobStep struct {
	ID             string   `json:"id"`
	StepOrder      int      `json:"stepOrder"`
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	DeploymentID   string   `json:"deploymentId"`
	Image          string   `json:"image"`
	Command        string   `json:"command"`
	Script         string   `json:"script"`
	ScriptRuntime  string   `json:"scriptRuntime"`
	EnvVars        []EnvVar `json:"envVars"`
	CPUMilli       flexNum  `json:"cpuRequestMilli"`
	MemoryRequestB flexNum  `json:"memoryRequestBytes"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	Retries        int      `json:"retries"`
}

type Job struct {
	ID                string      `json:"id"`
	Name              string      `json:"name"`
	Description       string      `json:"description"`
	ProjectID         string      `json:"projectId"`
	ProjectName       string      `json:"projectName"`
	OrganizationID    string      `json:"organizationId"`
	ScheduleCron      string      `json:"scheduleCron"`
	TimeZone          string      `json:"timeZone"`
	Enabled           bool        `json:"enabled"`
	ConcurrencyPolicy string      `json:"concurrencyPolicy"`
	NextRunAt         string      `json:"nextRunAt"`
	LastRun           *JobRunRef  `json:"lastRun"`
	RecentRuns        []JobRunRef `json:"recentRuns"`
	Steps             []JobStep   `json:"steps"`
}

type JobRunStep struct {
	StepOrder     int    `json:"stepOrder"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	ResolvedImage string `json:"resolvedImage"`
	Command       string `json:"command"`
	Status        string `json:"status"`
	ExitCode      *int   `json:"exitCode"`
	Reason        string `json:"reason"`
	StartedAt     string `json:"startedAt"`
	FinishedAt    string `json:"finishedAt"`
}

type JobRun struct {
	ID           string `json:"id"`
	JobID        string `json:"jobId"`
	JobName      string `json:"jobName"`
	Number       int    `json:"number"`
	Status       string `json:"status"`
	Trigger      string `json:"trigger"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	CreatedAt    string `json:"createdAt"`
	ErrorMessage string `json:"errorMessage"`
	TriggeredBy  *struct {
		Name     string `json:"name"`
		Username string `json:"username"`
	} `json:"triggeredBy"`
	Steps []JobRunStep `json:"steps"`
}

type (
	jobsMsg struct {
		items []Job
		err   error
	}
	jobMsg struct {
		j   *Job
		err error
	}
	jobRunsPageMsg struct {
		runs     []JobRun
		next     string
		appended bool
		err      error
	}
	jobDeletedMsg struct {
		name string
		err  error
	}
	runStartedMsg struct {
		run     *JobRun
		jobName string
		err     error
	}
)

func jobPath(id string, rest ...string) string {
	p := "/jobs/" + url.PathEscape(id)
	if len(rest) > 0 {
		p += "/" + strings.Join(rest, "/")
	}
	return p
}

// fetchJobs lists jobs for the project when one is scoped, otherwise the whole
// org (mirrors `orchard job list`).
func fetchJobs(cl *api.Client, orgID, projectID string) tea.Cmd {
	return func() tea.Msg {
		path := "/organizations/" + url.PathEscape(orgID) + "/jobs"
		if projectID != "" {
			path = "/projects/" + url.PathEscape(projectID) + "/jobs"
		}
		items, err := getList[Job](cl, path)
		return jobsMsg{items, err}
	}
}

func fetchJob(cl *api.Client, id string) tea.Cmd {
	return func() tea.Msg {
		var j Job
		if err := cl.GetJSON(context.Background(), jobPath(id), &j); err != nil {
			return jobMsg{nil, err}
		}
		return jobMsg{&j, nil}
	}
}

// fetchJobRuns pulls one cursor page of a job's run history; the envelope is
// {"runs": [...], "nextCursor": ...}.
func fetchJobRuns(cl *api.Client, jobID, cursor string, appended bool) tea.Cmd {
	return func() tea.Msg {
		p := jobPath(jobID, "runs")
		if cursor != "" {
			p += "?cursor=" + url.QueryEscape(cursor)
		}
		var page struct {
			Runs       []JobRun `json:"runs"`
			NextCursor string   `json:"nextCursor"`
		}
		err := cl.GetJSON(context.Background(), p, &page)
		return jobRunsPageMsg{page.Runs, page.NextCursor, appended, err}
	}
}

func startJobRunCmd(cl *api.Client, jobID, jobName string) tea.Cmd {
	return func() tea.Msg {
		var run JobRun
		err := cl.Send(context.Background(), "POST", jobPath(jobID, "runs"),
			map[string]any{"allowConcurrent": false}, &run)
		return runStartedMsg{&run, jobName, err}
	}
}

func setJobEnabledCmd(cl *api.Client, id, name string, enabled bool) tea.Cmd {
	did := "paused"
	if enabled {
		did = "resumed"
	}
	return doAction(cl, "PATCH", jobPath(id), map[string]any{"enabled": enabled},
		did+" schedule of "+name)
}

func deleteJobCmd(cl *api.Client, id, name string) tea.Cmd {
	return func() tea.Msg {
		err := cl.Send(context.Background(), "DELETE", jobPath(id), nil, nil)
		return jobDeletedMsg{name, err}
	}
}

// runTone maps a run/step status to the frontend RunHistoryStrip tones:
// succeeded=ok, failed/timed_out=fail, running/pending=live, rest muted.
func runTone(status string) string {
	switch lc(status) {
	case "succeeded":
		return colGreen
	case "failed", "timed_out":
		return colRed
	case "running", "pending":
		return colYellow
	}
	return colMuted
}

func runGlyph(status string) string {
	switch lc(status) {
	case "succeeded":
		return "✓"
	case "failed", "timed_out":
		return "✗"
	case "running":
		return "●"
	case "pending", "":
		return "○"
	}
	return "◌" // skipped / canceled
}

func runMark(status string) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(runTone(status))).Render(runGlyph(status))
}

func runStatusDot(status string) string {
	if status == "" {
		return stMuted.Render("○ -")
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(runTone(status))).Render("● " + lc(status))
}

// runDots renders the last-runs strip: fixed slots, oldest→newest left→right,
// colored per outcome (frontend RunHistoryStrip parity).
func runDots(runs []JobRunRef, slots int) string {
	n := min(len(runs), slots)
	var b strings.Builder
	for i := 0; i < slots-n; i++ {
		b.WriteString(stMuted.Render("·"))
	}
	for i := n - 1; i >= 0; i-- {
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(runTone(runs[i].Status))).Render("▮"))
	}
	return b.String()
}

// runDur renders elapsed time from a startedAt/finishedAt pair (running
// entries count up to now).
func runDur(started, finished string) string {
	if started == "" {
		return ""
	}
	st, err := time.Parse(time.RFC3339Nano, started)
	if err != nil {
		return ""
	}
	end := time.Now()
	if finished != "" {
		if et, perr := time.Parse(time.RFC3339Nano, finished); perr == nil {
			end = et
		}
	}
	d := end.Sub(st).Round(time.Second)
	if d < 0 {
		d = 0
	}
	return d.String()
}

// relWhen renders an ISO timestamp as "5m ago" / "in 2h".
func relWhen(iso string) string {
	if iso == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	d := time.Until(t)
	past := d < 0
	if past {
		d = -d
	}
	var s string
	switch {
	case d < time.Minute:
		s = fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		s = fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		s = fmt.Sprintf("%dh", int(d.Hours()))
	default:
		s = fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	if past {
		return s + " ago"
	}
	return "in " + s
}

func runActiveStatus(status string) bool {
	switch lc(status) {
	case "pending", "running":
		return true
	}
	return false
}

func jobActiveRun(j Job) *JobRunRef {
	if j.LastRun != nil && runActiveStatus(j.LastRun.Status) {
		return j.LastRun
	}
	return nil
}

type jobsListScreen struct {
	cl        *api.Client
	org       string
	projectID string
	jobs      []Job
	cursor    int
	err       error
	loading   bool
	sseLive   bool
	tickGen   int
	confirm   confirmModel
	hit       hitTable
	w, h      int
}

// newJobsListScreen lists the org's jobs, or just one project's when projectID
// is non-empty (this is the constructor project.go wires its jobs entry to).
func newJobsListScreen(cl *api.Client, orgID, projectID string) *jobsListScreen {
	return &jobsListScreen{cl: cl, org: orgID, projectID: projectID, loading: true}
}

func (s *jobsListScreen) orgID() string { return s.org }
func (s *jobsListScreen) title() string { return "Jobs" }

func (s *jobsListScreen) Init() tea.Cmd {
	return tea.Batch(fetchJobs(s.cl, s.org, s.projectID), s.tick())
}

func (s *jobsListScreen) tickEvery() time.Duration {
	if s.sseLive {
		return refreshEverySSE
	}
	return refreshEvery
}

func (s *jobsListScreen) tickID() string { return "jobs:" + s.org + ":" + s.projectID }

func (s *jobsListScreen) tick() tea.Cmd {
	gen := s.tickGen
	return tea.Tick(s.tickEvery(), func(time.Time) tea.Msg { return tickMsg{s.tickID(), gen} })
}

func (s *jobsListScreen) refresh() tea.Cmd { return fetchJobs(s.cl, s.org, s.projectID) }

// OnOrgEvent refreshes the list on any job/run change in scope.
func (s *jobsListScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	if ev.Type != "job.changed" && ev.Type != "jobrun.changed" {
		return nil
	}
	if s.projectID != "" && ev.ProjectID != "" && ev.ProjectID != s.projectID {
		return nil
	}
	return s.refresh()
}

func (s *jobsListScreen) sel() *Job {
	if s.cursor < 0 || s.cursor >= len(s.jobs) {
		return nil
	}
	return &s.jobs[s.cursor]
}

func (s *jobsListScreen) open() tea.Cmd {
	if j := s.sel(); j != nil {
		return push(newJobDetailScreen(s.cl, s.org, *j))
	}
	return nil
}

func (s *jobsListScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case jobsMsg:
		s.loading = false
		s.jobs, s.err = msg.items, msg.err
		if s.cursor >= len(s.jobs) {
			s.cursor = 0
		}
	case tickMsg:
		if msg.id == s.tickID() && msg.gen == s.tickGen {
			return s, tea.Batch(s.refresh(), s.tick())
		}
	case sseStatusMsg:
		if s.sseLive != msg.connected {
			s.sseLive = msg.connected
			s.tickGen++
			return s, s.tick()
		}
	case createdMsg:
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case jobDeletedMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(), flashf("deleted job %s", msg.name))
	case runStartedMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(),
			push(newJobRunScreen(s.cl, s.org, msg.jobName, msg.run.ID)))
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.cursor > 0 {
				s.cursor--
			}
		case tea.MouseButtonWheelDown:
			if s.cursor < len(s.jobs)-1 {
				s.cursor++
			}
		case tea.MouseButtonLeft:
			if msg.Action == tea.MouseActionPress {
				if idx := s.hit.rowAt(msg.X, msg.Y, s.cursor); idx >= 0 {
					if idx == s.cursor {
						return s, s.open()
					}
					s.cursor = idx
				}
			}
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "up", "k":
			if s.cursor > 0 {
				s.cursor--
			}
		case "down", "j":
			if s.cursor < len(s.jobs)-1 {
				s.cursor++
			}
		case "enter":
			return s, s.open()
		case "n":
			if s.projectID == "" {
				return s, errFlash(errInvalid("open a project to create a job"))
			}
			return s, push(newJobFormScreen(s.cl, s.projectID, nil))
		case "r":
			if j := s.sel(); j != nil {
				return s, startJobRunCmd(s.cl, j.ID, j.Name)
			}
		case "p":
			if j := s.sel(); j != nil {
				if j.ScheduleCron == "" {
					return s, errFlash(errInvalid("manual-only job has no schedule to pause"))
				}
				return s, setJobEnabledCmd(s.cl, j.ID, j.Name, !j.Enabled)
			}
		case "d":
			if j := s.sel(); j != nil {
				s.confirm.Show(fmt.Sprintf("Permanently delete job %q and its entire run history?", j.Name),
					deleteJobCmd(s.cl, j.ID, j.Name))
			}
		}
	}
	return s, nil
}

func (s *jobsListScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	return []keyHint{{"↑/↓", "move"}, {"enter", "open"}, {"n", "new"}, {"r", "run now"},
		{"p", "pause/resume"}, {"d", "delete"}, {"esc", "back"}}
}

func (s *jobsListScreen) View() string {
	return s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
}

func (s *jobsListScreen) view() string {
	if s.loading && len(s.jobs) == 0 && s.err == nil {
		return stMuted.Render("\n  loading jobs…")
	}
	bodyH := s.h - chromeH
	body := sectionErr(s.err)
	if body == "" {
		rows := make([][]string, len(s.jobs))
		for i, j := range s.jobs {
			sched := stMuted.Render("manual")
			if j.ScheduleCron != "" {
				sched = "⏱ " + j.ScheduleCron
			}
			state := stMuted.Render("-")
			if j.ScheduleCron != "" {
				if j.Enabled {
					state = stGreen.Render("on")
				} else {
					state = stYellow.Render("paused")
				}
			}
			last := stMuted.Render("-")
			if j.LastRun != nil {
				last = fmt.Sprintf("#%d %s %s", j.LastRun.Number, runStatusDot(j.LastRun.Status),
					stMuted.Render(relWhen(firstNonEmpty(j.LastRun.StartedAt, j.LastRun.CreatedAt))))
			}
			rows[i] = []string{
				j.Name,
				sched,
				state,
				last,
				runDots(j.RecentRuns, 10),
				stMuted.Render(relWhen(j.NextRunAt)),
			}
		}
		cols := []col{{title: "NAME"}, {title: "SCHEDULE"}, {title: "STATE"},
			{title: "LAST RUN"}, {title: "RUNS"}, {title: "NEXT RUN"}}
		body = renderTable(cols, rows, s.cursor, s.w-2, bodyH-2)
	}
	s.hit = hitTable{topY: 4, visible: bodyH - 4, count: len(s.jobs), minX: 0, maxX: s.w - 1}
	return panel(fmt.Sprintf("Jobs (%d)", len(s.jobs)), body, s.w, bodyH, true)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

var jobTabs = []string{"Overview", "Runs"}

type jobDetailScreen struct {
	cl       *api.Client
	org      string
	id, name string
	tab      int

	job        *Job
	runs       []JobRun
	nextCursor string
	runCursor  int
	moreBusy   bool

	tabSpans [][2]int
	hitRuns  hitTable
	confirm  confirmModel
	loading  bool
	sseLive  bool
	tickGen  int
	w, h     int
}

func newJobDetailScreen(cl *api.Client, org string, j Job) *jobDetailScreen {
	return &jobDetailScreen{cl: cl, org: org, id: j.ID, name: j.Name, loading: true}
}

func (s *jobDetailScreen) orgID() string { return s.org }
func (s *jobDetailScreen) title() string { return s.name }

func (s *jobDetailScreen) Init() tea.Cmd {
	return tea.Batch(fetchJob(s.cl, s.id), fetchJobRuns(s.cl, s.id, "", false), s.tick())
}

func (s *jobDetailScreen) tickEvery() time.Duration {
	if s.job != nil && jobActiveRun(*s.job) != nil {
		return 2 * time.Second
	}
	if s.sseLive {
		return refreshEverySSE
	}
	return refreshEvery
}

func (s *jobDetailScreen) tick() tea.Cmd {
	gen := s.tickGen
	return tea.Tick(s.tickEvery(), func(time.Time) tea.Msg { return tickMsg{"job:" + s.id, gen} })
}

func (s *jobDetailScreen) refresh() tea.Cmd {
	return tea.Batch(fetchJob(s.cl, s.id), fetchJobRuns(s.cl, s.id, "", false))
}

// OnOrgEvent refetches when this job (or one of its runs) changes.
func (s *jobDetailScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	switch ev.Type {
	case "job.changed":
		if ev.ID == s.id {
			return s.refresh()
		}
	case "jobrun.changed":
		var p struct {
			JobID string `json:"jobId"`
		}
		_ = json.Unmarshal(ev.Payload, &p)
		if p.JobID == s.id {
			return s.refresh()
		}
	}
	return nil
}

func (s *jobDetailScreen) selRun() *JobRun {
	if s.runCursor < 0 || s.runCursor >= len(s.runs) {
		return nil
	}
	return &s.runs[s.runCursor]
}

func (s *jobDetailScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if handled, cmd := s.confirm.Update(msg); handled {
		return s, cmd
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
	case jobMsg:
		s.loading = false
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		s.job = msg.j
		s.name = msg.j.Name
	case jobRunsPageMsg:
		s.moreBusy = false
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		if msg.appended {
			seen := map[string]bool{}
			for _, r := range s.runs {
				seen[r.ID] = true
			}
			for _, r := range msg.runs {
				if !seen[r.ID] {
					s.runs = append(s.runs, r)
				}
			}
		} else {
			s.runs = msg.runs
		}
		s.nextCursor = msg.next
		if s.runCursor >= len(s.runs) {
			s.runCursor = 0
		}
	case tickMsg:
		if msg.id == "job:"+s.id && msg.gen == s.tickGen {
			return s, tea.Batch(s.refresh(), s.tick())
		}
	case sseStatusMsg:
		if s.sseLive != msg.connected {
			s.sseLive = msg.connected
			s.tickGen++
			return s, s.tick()
		}
	case createdMsg:
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case actionMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(), flashf("%s", msg.text))
	case jobDeletedMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, finishForm(createdMsg{"deleted job " + msg.name})
	case runStartedMsg:
		if msg.err != nil {
			return s, errFlash(msg.err)
		}
		return s, tea.Batch(s.refresh(),
			push(newJobRunScreen(s.cl, s.org, msg.jobName, msg.run.ID)))
	case tea.MouseMsg:
		if msg.Button == tea.MouseButtonLeft && msg.Action == tea.MouseActionPress && msg.Y == 1 {
			for i, sp := range s.tabSpans {
				if msg.X >= sp[0] && msg.X <= sp[1] {
					s.tab = i
					return s, nil
				}
			}
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.tab == 1 && s.runCursor > 0 {
				s.runCursor--
			}
		case tea.MouseButtonWheelDown:
			if s.tab == 1 && s.runCursor < len(s.runs)-1 {
				s.runCursor++
			}
		case tea.MouseButtonLeft:
			if msg.Action == tea.MouseActionPress && s.tab == 1 {
				if idx := s.hitRuns.rowAt(msg.X, msg.Y, s.runCursor); idx >= 0 {
					if idx == s.runCursor {
						return s, s.openRun()
					}
					s.runCursor = idx
				}
			}
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "tab", "right", "l":
			s.tab = (s.tab + 1) % len(jobTabs)
		case "left", "h":
			s.tab = (s.tab - 1 + len(jobTabs)) % len(jobTabs)
		case "1", "2":
			s.tab = int(msg.String()[0] - '1')
		case "up", "k":
			if s.tab == 1 && s.runCursor > 0 {
				s.runCursor--
			}
		case "down", "j":
			if s.tab == 1 && s.runCursor < len(s.runs)-1 {
				s.runCursor++
			}
		case "enter":
			if s.tab == 1 {
				return s, s.openRun()
			}
		case "m":
			if s.tab == 1 && s.nextCursor != "" && !s.moreBusy {
				s.moreBusy = true
				return s, fetchJobRuns(s.cl, s.id, s.nextCursor, true)
			}
		case "r":
			return s, startJobRunCmd(s.cl, s.id, s.name)
		case "p":
			if s.job != nil {
				if s.job.ScheduleCron == "" {
					return s, errFlash(errInvalid("manual-only job has no schedule to pause"))
				}
				return s, setJobEnabledCmd(s.cl, s.id, s.name, !s.job.Enabled)
			}
		case "e":
			if s.job != nil {
				return s, push(newJobFormScreen(s.cl, s.job.ProjectID, s.job))
			}
		case "c":
			if s.job != nil {
				if run := jobActiveRun(*s.job); run != nil {
					s.confirm.Show(fmt.Sprintf("Cancel run #%d? Remaining steps are skipped.", run.Number),
						doAction(s.cl, "POST", "/job-runs/"+url.PathEscape(run.ID)+"/cancel",
							map[string]any{}, fmt.Sprintf("canceled run #%d", run.Number)))
				}
			}
		case "d":
			s.confirm.Show(fmt.Sprintf("Permanently delete job %q and its entire run history?", s.name),
				deleteJobCmd(s.cl, s.id, s.name))
		}
	}
	return s, nil
}

func (s *jobDetailScreen) openRun() tea.Cmd {
	if r := s.selRun(); r != nil {
		return push(newJobRunScreen(s.cl, s.org, s.name, r.ID))
	}
	return nil
}

func (s *jobDetailScreen) help() []keyHint {
	if s.confirm.Active() {
		return s.confirm.help()
	}
	hints := []keyHint{{"←/→", "tabs"}}
	if s.tab == 1 {
		hints = append(hints, keyHint{"↑/↓", "move"}, keyHint{"enter", "open run"})
		if s.nextCursor != "" {
			hints = append(hints, keyHint{"m", "more"})
		}
	}
	hints = append(hints, keyHint{"r", "run now"}, keyHint{"p", "pause/resume"},
		keyHint{"e", "edit"})
	if s.job != nil && jobActiveRun(*s.job) != nil {
		hints = append(hints, keyHint{"c", "cancel run"})
	}
	return append(hints, keyHint{"d", "delete"}, keyHint{"esc", "back"})
}

func (s *jobDetailScreen) View() string {
	return s.confirm.Overlay(s.view(), s.w, s.h-chromeH)
}

func (s *jobDetailScreen) view() string {
	if s.loading && s.job == nil {
		return stMuted.Render("\n  loading job…")
	}
	bodyH := s.h - chromeH
	strip := renderTabs(jobTabs, s.tab)
	spans := make([][2]int, len(jobTabs))
	x := 4
	for i, t := range jobTabs {
		spans[i] = [2]int{x, x + len(t) - 1}
		x += len(t) + 3
	}
	s.tabSpans = spans

	if s.tab == 1 {
		s.hitRuns = hitTable{topY: 4, visible: bodyH - 4, count: len(s.runs), minX: 0, maxX: s.w - 1}
		return panelRaw(strip, s.viewRuns(bodyH), s.w, bodyH, true)
	}
	return s.viewOverview(bodyH, strip)
}

func (s *jobDetailScreen) viewOverview(height int, strip string) string {
	j := s.job
	if j == nil {
		return stMuted.Render("  no data")
	}
	leftW := s.w * 2 / 5
	rightW := s.w - leftW

	var info strings.Builder
	row := func(k, v string) {
		info.WriteString(stKey.Render(pad(k, 12)) + " " + v + "\n")
	}
	state := "manual"
	if j.ScheduleCron != "" {
		state = "active"
		if !j.Enabled {
			state = "paused"
		}
	}
	row("Status", badge(state))
	sched := stMuted.Render("manual (run on demand)")
	if j.ScheduleCron != "" {
		sched = j.ScheduleCron
	}
	row("Schedule", sched)
	if j.TimeZone != "" {
		row("Timezone", j.TimeZone)
	}
	if j.ConcurrencyPolicy != "" {
		row("Overlap", map[string]string{"forbid": "skip new run", "allow": "run in parallel"}[j.ConcurrencyPolicy])
	}
	if j.ScheduleCron != "" && j.Enabled {
		row("Next run", relWhen(j.NextRunAt))
	}
	if j.LastRun != nil {
		row("Last run", fmt.Sprintf("#%d %s %s", j.LastRun.Number, runStatusDot(j.LastRun.Status),
			stMuted.Render(relWhen(firstNonEmpty(j.LastRun.StartedAt, j.LastRun.CreatedAt)))))
	}
	if len(j.RecentRuns) > 0 {
		row("History", runDots(j.RecentRuns, 10))
	}
	if j.ProjectName != "" {
		row("Project", stMuted.Render(j.ProjectName))
	}
	if j.Description != "" {
		row("About", stMuted.Render(j.Description))
	}

	stepRows := make([][]string, len(j.Steps))
	for i, st := range j.Steps {
		stepRows[i] = []string{
			fmt.Sprintf("%d", st.StepOrder),
			st.Name,
			stepKindLabel(st.Type, st.ScriptRuntime),
			stMuted.Render(truncate(stepSummary(st), 40)),
		}
	}
	stepsBody := renderTable([]col{{title: "#"}, {title: "NAME"}, {title: "TYPE"}, {title: "DETAIL"}},
		stepRows, -1, rightW-2, height-2)

	left := panelRaw(strip, info.String(), leftW, height, true)
	right := panel(fmt.Sprintf("Steps (%d)", len(j.Steps)), stepsBody, rightW, height, false)
	return sideBySide(left, right)
}

func stepKindLabel(typ, runtime string) string {
	if typ == "script" && runtime != "" {
		return typ + " · " + runtime
	}
	return typ
}

func stepSummary(st JobStep) string {
	switch st.Type {
	case "script":
		for _, ln := range strings.Split(st.Script, "\n") {
			ln = strings.TrimSpace(ln)
			if ln != "" && !strings.HasPrefix(ln, "#!") {
				return ln
			}
		}
		return ""
	case "image":
		if st.Command != "" {
			return st.Image + " · " + st.Command
		}
		return st.Image
	}
	return st.Command
}

func (s *jobDetailScreen) viewRuns(height int) string {
	rows := make([][]string, len(s.runs))
	for i, r := range s.runs {
		trigger := r.Trigger
		if r.Trigger == "cron" {
			trigger = "schedule"
		} else if r.TriggeredBy != nil && r.TriggeredBy.Name != "" {
			trigger = r.TriggeredBy.Name
		}
		var dots strings.Builder
		for _, st := range r.Steps {
			dots.WriteString(runMark(st.Status))
		}
		rows[i] = []string{
			fmt.Sprintf("#%d", r.Number),
			runStatusDot(r.Status),
			stMuted.Render(trigger),
			stMuted.Render(relWhen(firstNonEmpty(r.StartedAt, r.CreatedAt))),
			runDur(r.StartedAt, r.FinishedAt),
			dots.String(),
		}
	}
	cols := []col{{title: "RUN"}, {title: "STATUS"}, {title: "TRIGGER"},
		{title: "STARTED"}, {title: "DURATION"}, {title: "STEPS"}}
	body := renderTable(cols, rows, s.runCursor, s.w-2, height-2)
	if s.nextCursor != "" {
		more := "m: load more"
		if s.moreBusy {
			more = "loading…"
		}
		body += "\n  " + stMuted.Render(more)
	}
	return body
}
