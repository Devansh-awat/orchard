package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// stubScreen records what the root forwards to it.
type stubScreen struct {
	events []api.OrgEvent
	status []bool
	org    string
}

func (s *stubScreen) Init() tea.Cmd { return nil }
func (s *stubScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	if st, ok := msg.(sseStatusMsg); ok {
		s.status = append(s.status, st.connected)
	}
	return s, nil
}
func (s *stubScreen) View() string    { return "stub" }
func (s *stubScreen) title() string   { return "stub" }
func (s *stubScreen) help() []keyHint { return nil }
func (s *stubScreen) OnOrgEvent(ev api.OrgEvent) tea.Cmd {
	s.events = append(s.events, ev)
	return nil
}
func (s *stubScreen) orgID() string { return s.org }

func newLiveRoot(stub *stubScreen) model {
	m := model{stack: []screen{stub}}
	m.sse.ensure()
	m.sse.gen = 1
	return m
}

func step(t *testing.T, m model, msg tea.Msg) model {
	t.Helper()
	nm, _ := m.Update(msg)
	return nm.(model)
}

func TestSSEEventRoutesToOnOrgEvent(t *testing.T) {
	stub := &stubScreen{}
	m := newLiveRoot(stub)

	ev := api.OrgEvent{Type: "deployment.changed", ID: "d1", TS: 1}
	m = step(t, m, sseEventMsg{gen: 1, ev: ev})

	if len(stub.events) != 1 || stub.events[0].ID != "d1" {
		t.Fatalf("event not forwarded to OnOrgEvent: %+v", stub.events)
	}
	if !m.sse.connected {
		t.Fatal("a delivered event should mark the stream connected")
	}
	if len(stub.status) != 1 || !stub.status[0] {
		t.Fatalf("connected status not broadcast to screens: %+v", stub.status)
	}
}

func TestSSEDebounceCollapsesBursts(t *testing.T) {
	stub := &stubScreen{}
	m := newLiveRoot(stub)
	now := time.Unix(1000, 0)
	m.sse.now = func() time.Time { return now }

	send := func(ts int64) tea.Cmd {
		nm, cmd := m.Update(sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "deployment.changed", ID: "d1", TS: ts}})
		m = nm.(model)
		return cmd
	}

	send(1) // first of the burst: forwarded immediately
	now = now.Add(50 * time.Millisecond)
	send(2) // inside the window: queued as the trailing event
	now = now.Add(50 * time.Millisecond)
	send(3) // still inside: replaces the queued event, no extra flush

	if len(stub.events) != 1 || stub.events[0].TS != 1 {
		t.Fatalf("burst should forward only the first event, got %+v", stub.events)
	}

	m = step(t, m, sseFlushMsg{key: "deployment.changed|d1"})
	if len(stub.events) != 2 || stub.events[1].TS != 3 {
		t.Fatalf("flush should deliver only the latest queued event, got %+v", stub.events)
	}

	// a different entity id is its own debounce key: forwarded immediately
	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "deployment.changed", ID: "d2", TS: 4}})
	if len(stub.events) != 3 || stub.events[2].ID != "d2" {
		t.Fatalf("distinct entity should not be debounced, got %+v", stub.events)
	}
}

func TestSSEImmediateDispatchSupersedesQueuedEvent(t *testing.T) {
	stub := &stubScreen{}
	m := newLiveRoot(stub)
	now := time.Unix(1000, 0)
	m.sse.now = func() time.Time { return now }

	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "build.changed", ID: "d1", TS: 1}})
	now = now.Add(100 * time.Millisecond)
	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "build.changed", ID: "d1", TS: 2}}) // queued

	// window expires before the flush lands; a fresh event dispatches now and
	// must drop the stale queued one
	now = now.Add(sseDebounce)
	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "build.changed", ID: "d1", TS: 3}})
	m = step(t, m, sseFlushMsg{key: "build.changed|d1"})

	if len(stub.events) != 2 || stub.events[1].TS != 3 {
		t.Fatalf("stale queued event should be superseded, got %+v", stub.events)
	}
}

func TestSSEGenerationGuardDropsStaleMessages(t *testing.T) {
	stub := &stubScreen{}
	m := newLiveRoot(stub)
	m.sse.gen = 2
	m.sse.connected = true

	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "deployment.changed", ID: "d1"}})
	if len(stub.events) != 0 {
		t.Fatalf("stale-generation event must be dropped, got %+v", stub.events)
	}

	m = step(t, m, sseErrMsg{gen: 1, err: errFake})
	if !m.sse.connected {
		t.Fatal("stale-generation error must not flip connected")
	}
	m = step(t, m, sseClosedMsg{gen: 1})
	if !m.sse.connected {
		t.Fatal("stale-generation close must not flip connected")
	}

	// current-generation error and close do flip it
	m = step(t, m, sseErrMsg{gen: 2, err: errFake})
	if m.sse.connected {
		t.Fatal("current-generation error should mark the stream down")
	}
	if len(stub.status) == 0 || stub.status[len(stub.status)-1] {
		t.Fatalf("disconnect should broadcast connected=false, got %+v", stub.status)
	}
}

var errFake = errStub("stream reset")

type errStub string

func (e errStub) Error() string { return string(e) }

func TestStartSSEClearsDebounceStateOnOrgChange(t *testing.T) {
	cl, _ := fakeAPI(t)
	stub := &stubScreen{}
	m := newLiveRoot(stub)
	m.cl = cl
	m.sse.orgID = "o1"
	m.sse.pending["deployment.changed|d1"] = api.OrgEvent{Type: "deployment.changed", ID: "d1"}
	m.sse.lastSent["deployment.changed|d1"] = time.Now()
	gen := m.sse.gen

	if cmd := m.startSSE("o2", ""); cmd == nil {
		t.Fatal("startSSE should arm the subscription pumps")
	}
	defer m.sse.cancel()

	if m.sse.gen != gen+1 {
		t.Fatalf("startSSE should bump the generation: %d -> %d", gen, m.sse.gen)
	}
	if m.sse.orgID != "o2" {
		t.Fatalf("startSSE should track the new org, got %q", m.sse.orgID)
	}
	if len(m.sse.pending) != 0 || len(m.sse.lastSent) != 0 {
		t.Fatalf("org switch must clear debounce state: pending=%v lastSent=%v", m.sse.pending, m.sse.lastSent)
	}

	m = step(t, m, sseFlushMsg{key: "deployment.changed|d1"})
	if len(stub.events) != 0 {
		t.Fatalf("flush after org switch must dispatch nothing, got %+v", stub.events)
	}

	// same-org resubscribe is a no-op via switchSSE
	if cmd := m.switchSSE("o2"); cmd != nil {
		t.Fatal("switchSSE to the current org should not resubscribe")
	}
}

func TestMembershipChangedResubscribes(t *testing.T) {
	cl, _ := fakeAPI(t)
	stub := &stubScreen{}
	m := newLiveRoot(stub)
	m.cl = cl
	m.sse.orgID = "o1"

	m = step(t, m, sseEventMsg{gen: 1, ev: api.OrgEvent{Type: "membership.changed", EventID: "7-0"}})
	defer m.sse.cancel()

	if m.sse.gen != 2 {
		t.Fatalf("membership.changed should tear down and resubscribe, gen=%d", m.sse.gen)
	}
	if m.sse.lastEventID != "7-0" {
		t.Fatalf("resubscribe should resume from the last event id, got %q", m.sse.lastEventID)
	}
}

func TestAdaptiveTickSwitchesCadence(t *testing.T) {
	cl, _ := fakeAPI(t)
	d := &deploymentScreen{cl: cl, id: "d1", name: "api"}

	if got := d.tickEvery(); got != refreshEvery {
		t.Fatalf("polling cadence should be %v while SSE is down, got %v", refreshEvery, got)
	}

	var s screen = d
	s, cmd := s.Update(sseStatusMsg{connected: true})
	if cmd == nil {
		t.Fatal("cadence change should restart the tick")
	}
	if got := d.tickEvery(); got != refreshEverySSE {
		t.Fatalf("cadence should stretch to %v while SSE delivers, got %v", refreshEverySSE, got)
	}

	// the in-flight tick from the old cadence is orphaned by the gen bump
	_, cmd = s.Update(tickMsg{id: "d1", gen: 0})
	if cmd != nil {
		t.Fatal("stale-generation tick must be ignored")
	}
	_, cmd = s.Update(tickMsg{id: "d1", gen: d.tickGen})
	if cmd == nil {
		t.Fatal("current-generation tick should refresh and re-arm")
	}

	// same status again: no restart churn
	_, cmd = s.Update(sseStatusMsg{connected: true})
	if cmd != nil {
		t.Fatal("unchanged status should not restart the tick")
	}

	s, cmd = s.Update(sseStatusMsg{connected: false})
	if cmd == nil || d.tickEvery() != refreshEvery {
		t.Fatalf("losing SSE should fall back to fast polling, got %v", d.tickEvery())
	}
	_ = s
}

func TestConfirmModalOnDeploymentDelete(t *testing.T) {
	cl, cap := fakeAPI(t)
	d := &deploymentScreen{cl: cl, id: "d1", name: "api", loading: true}
	var s screen = d
	s, _ = s.Update(tea.WindowSizeMsg{Width: 120, Height: 40})

	key := func(k string) tea.Cmd {
		var cmd tea.Cmd
		if k == "esc" {
			s, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEsc})
		} else {
			s, cmd = s.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		}
		return cmd
	}

	key("x")
	if !d.confirm.Active() {
		t.Fatal("x should arm the delete confirmation")
	}
	v := s.View()
	if !strings.Contains(v, "Confirm") || !strings.Contains(v, "delete deployment") {
		t.Fatalf("confirm overlay missing from view:\n%s", v)
	}
	if h := s.(*deploymentScreen).help(); h[0][0] != "y/enter" {
		t.Fatalf("keybar should show confirm hints while modal is up, got %+v", h)
	}

	// other keys and clicks are swallowed while the modal is up
	if cmd := key("R"); cmd != nil {
		t.Fatal("restart key must be swallowed by the modal")
	}
	s, _ = s.Update(tea.MouseMsg{X: 5, Y: 1, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	if d.tab != 0 {
		t.Fatalf("tab click must not pass through the modal, tab=%d", d.tab)
	}

	// n cancels
	if cmd := key("n"); cmd != nil || d.confirm.Active() {
		t.Fatal("n should cancel without running the action")
	}

	// esc cancels (and is not routed to pop while the modal is up)
	key("x")
	if cmd := key("esc"); cmd != nil || d.confirm.Active() {
		t.Fatal("esc should cancel the modal, not pop the screen")
	}

	// y runs the armed delete
	key("x")
	cmd := key("y")
	if cmd == nil || d.confirm.Active() {
		t.Fatal("y should dismiss the modal and run the action")
	}
	if msg, ok := run(cmd).(deleteDoneMsg); !ok || msg.err != nil {
		t.Fatalf("confirm should run the delete, got %+v", msg)
	}
	cap.mu.Lock()
	_, hit := cap.hits["DELETE /apiv1/deployments/d1"]
	cap.mu.Unlock()
	if !hit {
		t.Fatal("delete endpoint was not called")
	}
}

func TestHeaderLiveIndicatorStates(t *testing.T) {
	m := model{w: 80, stack: []screen{&stubScreen{}}}

	if bar := m.headerBar(); !strings.Contains(bar, "○ polling") {
		t.Fatalf("header should show polling while SSE is down:\n%s", bar)
	}
	m.sse.connected = true
	if bar := m.headerBar(); !strings.Contains(bar, "● live") {
		t.Fatalf("header should show live while SSE delivers:\n%s", bar)
	}
}
