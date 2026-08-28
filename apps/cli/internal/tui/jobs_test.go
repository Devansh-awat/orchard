package tui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

func jobsFakeAPI(t *testing.T) (*api.Client, *capture) {
	t.Helper()
	cap := &capture{hits: map[string]json.RawMessage{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io_ReadAll(r)
		cap.mu.Lock()
		cap.hits[r.Method+" "+r.URL.Path] = body
		cap.mu.Unlock()
		p := r.URL.Path
		switch {
		case (p == "/apiv1/projects/p1/jobs" || p == "/apiv1/organizations/o1/jobs") && r.Method == "GET":
			w.Write([]byte(`[
				{"id":"j1","name":"nightly-cleanup","projectId":"p1","projectName":"web-app",
				 "scheduleCron":"0 2 * * *","timeZone":"UTC","enabled":true,"concurrencyPolicy":"forbid",
				 "nextRunAt":"2026-07-14T02:00:00Z",
				 "lastRun":{"id":"r1","number":4,"status":"succeeded","startedAt":"2026-07-13T02:00:00Z","finishedAt":"2026-07-13T02:03:00Z"},
				 "recentRuns":[{"id":"r1","number":4,"status":"succeeded"},{"id":"r0","number":3,"status":"failed"}]},
				{"id":"j2","name":"manual-job","projectId":"p1","enabled":true,"scheduleCron":null,"lastRun":null,"recentRuns":[]}
			]`))
		case p == "/apiv1/jobs/j1" && r.Method == "GET":
			w.Write([]byte(`{"id":"j1","name":"nightly-cleanup","projectId":"p1","projectName":"web-app",
				"scheduleCron":"0 2 * * *","timeZone":"UTC","enabled":true,"concurrencyPolicy":"forbid",
				"nextRunAt":"2026-07-14T02:00:00Z",
				"lastRun":{"id":"r1","number":4,"status":"succeeded","startedAt":"2026-07-13T02:00:00Z"},
				"steps":[
				 {"id":"s1","stepOrder":1,"name":"refresh","type":"script","scriptRuntime":"bash","script":"echo hi","envVars":[],"timeoutSeconds":1800,"retries":0,"memoryRequestBytes":"268435456"},
				 {"id":"s2","stepOrder":2,"name":"prune","type":"image","image":"alpine:3","command":"echo done","envVars":[]}
				]}`))
		case p == "/apiv1/jobs/j1/runs" && r.Method == "GET":
			if r.URL.Query().Get("cursor") != "" {
				w.Write([]byte(`{"runs":[{"id":"r0","jobId":"j1","number":3,"status":"failed","trigger":"cron","startedAt":"2026-07-12T02:00:00Z","finishedAt":"2026-07-12T02:01:00Z"}],"nextCursor":null}`))
				return
			}
			w.Write([]byte(`{"runs":[{"id":"r1","jobId":"j1","number":4,"status":"succeeded","trigger":"manual",
				"triggeredBy":{"id":"u1","username":"seb","name":"Seb"},
				"startedAt":"2026-07-13T02:00:00Z","finishedAt":"2026-07-13T02:03:00Z",
				"steps":[{"stepOrder":1,"name":"refresh","type":"script","status":"succeeded"},{"stepOrder":2,"name":"prune","type":"image","status":"succeeded"}]}],
				"nextCursor":"cur1"}`))
		case p == "/apiv1/jobs/j1/runs" && r.Method == "POST":
			w.Write([]byte(`{"id":"r9","jobId":"j1","number":5,"status":"pending"}`))
		case p == "/apiv1/job-runs/r1" && r.Method == "GET":
			w.Write([]byte(`{"id":"r1","jobId":"j1","jobName":"nightly-cleanup","number":4,"status":"running","trigger":"manual",
				"startedAt":"2026-07-13T02:00:00Z",
				"steps":[
				 {"stepOrder":1,"name":"refresh","type":"script","status":"succeeded","startedAt":"2026-07-13T02:00:00Z","finishedAt":"2026-07-13T02:01:00Z","exitCode":0},
				 {"stepOrder":2,"name":"prune","type":"image","status":"running","startedAt":"2026-07-13T02:01:00Z"}
				]}`))
		case strings.HasPrefix(p, "/apiv1/job-runs/r1/steps/") && strings.HasSuffix(p, "/logs"):
			w.Write([]byte(`{"logs":"pruning old rows\nstill going","truncated":false,"live":true}`))
		case p == "/apiv1/projects/p1/deployments":
			w.Write([]byte(`[{"id":"d1","name":"api"},{"id":"d2","name":"worker"}]`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), cap
}

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }

// expandCmds flattens one level of tea.Batch so tests can inspect every msg a
// handler produced.
func expandCmds(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); ok {
		out := []tea.Msg{}
		for _, c := range batch {
			out = append(out, expandCmds(c)...)
		}
		return out
	}
	return []tea.Msg{msg}
}

func TestJobsListScreenRenders(t *testing.T) {
	cl, _ := jobsFakeAPI(t)
	var s screen = newJobsListScreen(cl, "o1", "p1")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	s, _ = s.Update(run(fetchJobs(cl, "o1", "p1")))
	v := s.View()
	if !strings.Contains(v, "nightly-cleanup") || !strings.Contains(v, "manual-job") {
		t.Fatalf("jobs list missing job names:\n%s", v)
	}
	if !strings.Contains(v, "0 2 * * *") {
		t.Fatalf("jobs list missing schedule badge:\n%s", v)
	}
	if !strings.Contains(v, "▮") {
		t.Fatalf("jobs list missing recent-run dots strip:\n%s", v)
	}
}

func TestJobsListKeyRouting(t *testing.T) {
	cl, cap := jobsFakeAPI(t)
	var s screen = newJobsListScreen(cl, "o1", "p1")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	s, _ = s.Update(run(fetchJobs(cl, "o1", "p1")))

	// n → job form for the scoped project
	_, cmd := s.Update(keyRune("n"))
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("n should push a screen")
	} else if f, ok := ps.s.(*jobForm); !ok || f.projectID != "p1" {
		t.Fatalf("n should open the job form for p1, got %T", ps.s)
	}

	// enter → job detail
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("enter should push a screen")
	} else if d, ok := ps.s.(*jobDetailScreen); !ok || d.id != "j1" {
		t.Fatalf("enter should open job j1, got %T", ps.s)
	}

	// p → PATCH enabled=false (j1 is enabled with a cron)
	_, cmd = s.Update(keyRune("p"))
	if _, ok := run(cmd).(actionMsg); !ok {
		t.Fatal("p should produce an actionMsg")
	}
	cap.mu.Lock()
	patchBody := string(cap.hits["PATCH /apiv1/jobs/j1"])
	cap.mu.Unlock()
	if !strings.Contains(patchBody, `"enabled":false`) {
		t.Fatalf("pause should PATCH enabled=false, got %q", patchBody)
	}

	// d → confirm modal, y → DELETE
	ls := s.(*jobsListScreen)
	s, _ = s.Update(keyRune("d"))
	if !ls.confirm.Active() {
		t.Fatal("d should arm the confirm modal")
	}
	_, cmd = s.Update(keyRune("y"))
	if del, ok := run(cmd).(jobDeletedMsg); !ok || del.err != nil {
		t.Fatalf("confirming should delete, got %T", run(cmd))
	}
	cap.mu.Lock()
	_, deleted := cap.hits["DELETE /apiv1/jobs/j1"]
	cap.mu.Unlock()
	if !deleted {
		t.Fatal("DELETE /jobs/j1 was never hit")
	}
}

func TestJobsListRunNowOpensRun(t *testing.T) {
	cl, cap := jobsFakeAPI(t)
	var s screen = newJobsListScreen(cl, "o1", "p1")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	s, _ = s.Update(run(fetchJobs(cl, "o1", "p1")))

	_, cmd := s.Update(keyRune("r"))
	started, ok := run(cmd).(runStartedMsg)
	if !ok || started.err != nil {
		t.Fatalf("r should start a run, got %+v", started)
	}
	cap.mu.Lock()
	body := string(cap.hits["POST /apiv1/jobs/j1/runs"])
	cap.mu.Unlock()
	if !strings.Contains(body, `"allowConcurrent":false`) {
		t.Fatalf("run-now body wrong: %q", body)
	}
	_, cmd = s.Update(started)
	var opened bool
	for _, m := range expandCmds(cmd) {
		if ps, ok := m.(pushScreen); ok {
			if r, ok := ps.s.(*jobRunScreen); ok && r.runID == "r9" {
				opened = true
			}
		}
	}
	if !opened {
		t.Fatal("runStartedMsg should push the run detail screen")
	}
}

func TestJobDetailScreenTabs(t *testing.T) {
	cl, _ := jobsFakeAPI(t)
	var s screen = newJobDetailScreen(cl, "o1", Job{ID: "j1", Name: "nightly-cleanup"})
	s, _ = s.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	s, _ = s.Update(run(fetchJob(cl, "j1")))
	s, _ = s.Update(run(fetchJobRuns(cl, "j1", "", false)))

	overview := s.View()
	if !strings.Contains(overview, "0 2 * * *") {
		t.Fatalf("overview missing schedule:\n%s", overview)
	}
	if !strings.Contains(overview, "refresh") || !strings.Contains(overview, "script · bash") {
		t.Fatalf("overview missing steps table:\n%s", overview)
	}

	// runs tab
	s, _ = s.Update(keyRune("2"))
	runsView := s.View()
	if !strings.Contains(runsView, "#4") || !strings.Contains(runsView, "Seb") {
		t.Fatalf("runs tab missing run row:\n%s", runsView)
	}
	if !strings.Contains(runsView, "load more") {
		t.Fatalf("runs tab should hint at the next cursor page:\n%s", runsView)
	}

	// m → fetch the cursor page and append it
	_, cmd := s.Update(keyRune("m"))
	s, _ = s.Update(run(cmd))
	ds := s.(*jobDetailScreen)
	if len(ds.runs) != 2 || ds.nextCursor != "" {
		t.Fatalf("load more should append run r0, got %d runs (cursor %q)", len(ds.runs), ds.nextCursor)
	}

	// enter opens the selected run
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("enter on runs tab should push the run screen")
	} else if _, ok := ps.s.(*jobRunScreen); !ok {
		t.Fatalf("expected a run screen, got %T", ps.s)
	}
}

func TestJobRunScreenRendersPipelineAndLogs(t *testing.T) {
	cl, _ := jobsFakeAPI(t)
	var s screen = newJobRunScreen(cl, "o1", "nightly-cleanup", "r1")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	s, _ = s.Update(run(fetchJobRun(cl, "r1")))

	rs := s.(*jobRunScreen)
	if rs.stepSel != 1 {
		t.Fatalf("should auto-select the running step, got %d", rs.stepSel)
	}
	s, _ = s.Update(run(fetchStepLogs(cl, "r1", 2)))
	v := s.View()
	if !strings.Contains(v, "refresh") || !strings.Contains(v, "prune") {
		t.Fatalf("run view missing step pipeline:\n%s", v)
	}
	if !strings.Contains(v, "✓") {
		t.Fatalf("run view missing success glyph:\n%s", v)
	}
	if !strings.Contains(v, "pruning old rows") {
		t.Fatalf("run view missing step logs:\n%s", v)
	}
	if got := s.title(); !strings.Contains(got, "#4") {
		t.Fatalf("title should carry the run number, got %q", got)
	}
}

func TestJobRunCancelConfirm(t *testing.T) {
	cl, cap := jobsFakeAPI(t)
	var s screen = newJobRunScreen(cl, "o1", "nightly-cleanup", "r1")
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	s, _ = s.Update(run(fetchJobRun(cl, "r1")))

	rs := s.(*jobRunScreen)
	s, _ = s.Update(keyRune("c"))
	if !rs.confirm.Active() {
		t.Fatal("c should arm the cancel confirm")
	}
	_, cmd := s.Update(keyRune("y"))
	if am, ok := run(cmd).(actionMsg); !ok || am.err != nil {
		t.Fatalf("confirm should cancel the run, got %T", run(cmd))
	}
	cap.mu.Lock()
	_, hit := cap.hits["POST /apiv1/job-runs/r1/cancel"]
	cap.mu.Unlock()
	if !hit {
		t.Fatal("POST /job-runs/r1/cancel was never hit")
	}
}

func TestJobFormCreateSubmit(t *testing.T) {
	cl, cap := jobsFakeAPI(t)
	f := newJobFormScreen(cl, "p1", nil)
	f.name.SetValue("nightly")
	f.schedIdx = 3 // daily at 02:00
	f.tz.SetValue("America/New_York")
	f.steps[0].body.SetValue("echo hi")
	f.steps[0].env.SetValue("A=1")

	_, cmd := f.submit()
	res, ok := run(cmd).(formResult)
	if !ok || res.err != nil {
		t.Fatalf("create submit failed: %+v", res)
	}
	cap.mu.Lock()
	body := string(cap.hits["POST /apiv1/projects/p1/jobs"])
	cap.mu.Unlock()
	for _, want := range []string{`"name":"nightly"`, `"scheduleCron":"0 2 * * *"`,
		`"timeZone":"America/New_York"`, `"scriptRuntime":"bash"`, `"script":"echo hi"`,
		`"key":"A"`, `"type":"script"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("create body missing %s: %q", want, body)
		}
	}
}

func TestJobFormEditSubmitPreservesAdvancedFields(t *testing.T) {
	cl, cap := jobsFakeAPI(t)
	job := Job{
		ID: "j1", Name: "nightly-cleanup", ScheduleCron: "0 2 * * *", TimeZone: "UTC",
		Steps: []JobStep{{
			StepOrder: 1, Name: "refresh", Type: "script", ScriptRuntime: "python",
			Script: "print(1)", TimeoutSeconds: 900, Retries: 2,
			CPUMilli: 250, MemoryRequestB: 268435456,
		}},
	}
	f := newJobFormScreen(cl, "p1", &job)
	if f.schedIdx != 3 {
		t.Fatalf("edit form should seed the daily preset, got %d", f.schedIdx)
	}
	_, cmd := f.submit()
	res, ok := run(cmd).(formResult)
	if !ok || res.err != nil {
		t.Fatalf("edit submit failed: %+v", res)
	}
	cap.mu.Lock()
	patch := string(cap.hits["PATCH /apiv1/jobs/j1"])
	steps := string(cap.hits["PUT /apiv1/jobs/j1/steps"])
	cap.mu.Unlock()
	if !strings.Contains(patch, `"name":"nightly-cleanup"`) || !strings.Contains(patch, `"scheduleCron":"0 2 * * *"`) {
		t.Fatalf("edit PATCH body wrong: %q", patch)
	}
	for _, want := range []string{`"scriptRuntime":"python"`, `"timeoutSeconds":900`,
		`"retries":2`, `"cpuRequestMilli":250`, `"memoryRequestBytes":268435456`} {
		if !strings.Contains(steps, want) {
			t.Fatalf("steps PUT missing %s: %q", want, steps)
		}
	}
}

func TestJobFormStepEditor(t *testing.T) {
	cl, _ := jobsFakeAPI(t)
	var s screen = newJobFormScreen(cl, "p1", nil)
	s, _ = s.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	f := s.(*jobForm)

	// ctrl+n adds a step and focuses it
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyCtrlN})
	if len(f.steps) != 2 {
		t.Fatalf("ctrl+n should add a step, have %d", len(f.steps))
	}
	f.steps[0].name.SetValue("one")
	f.steps[1].name.SetValue("two")
	if got := f.cur(); got != (jfRef{1, 0}) {
		t.Fatalf("focus should land on the new step name, got %+v", got)
	}

	// type cycler on step 2: right → script · python
	f.focusOn(jfRef{1, 1})
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyRight})
	if f.steps[1].kind != 1 {
		t.Fatalf("right should cycle the step type, got kind %d", f.steps[1].kind)
	}

	// ctrl+k moves step 2 up
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if f.steps[0].name.Value() != "two" {
		t.Fatalf("ctrl+k should move the step up, order is %q,%q",
			f.steps[0].name.Value(), f.steps[1].name.Value())
	}

	// ctrl+x removes the focused step
	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyCtrlX})
	if len(f.steps) != 1 || f.steps[0].name.Value() != "one" {
		t.Fatalf("ctrl+x should remove the focused step, left %d", len(f.steps))
	}

	if v := s.View(); !strings.Contains(v, "Steps") || !strings.Contains(v, "Schedule") {
		t.Fatalf("form view missing sections:\n%s", v)
	}
}

func TestJobFormValidation(t *testing.T) {
	cl, _ := jobsFakeAPI(t)
	f := newJobFormScreen(cl, "p1", nil)
	if _, cmd := f.submit(); cmd != nil || f.errText == "" {
		t.Fatal("submit without a name should set an error")
	}
	f.name.SetValue("x")
	if _, cmd := f.submit(); cmd != nil || !strings.Contains(f.errText, "script is required") {
		t.Fatalf("script step without a script should error, got %q", f.errText)
	}
}
