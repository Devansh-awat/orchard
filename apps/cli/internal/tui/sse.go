package tui

import (
	"context"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// The org event bus is bursty (one deploy emits deployment.changed +
// build.changed several times a second) and the API is rate-limited to
// 200 req/60s. Debounce per (type, entity id): the first event of a burst is
// forwarded immediately, the rest collapse into one trailing flush, so screens
// refetch at most ~3x/s per entity.
const sseDebounce = 300 * time.Millisecond

type (
	// sseEventMsg / sseErrMsg / sseClosedMsg drive the root's subscription
	// pump. Each carries the subscription generation so messages from a
	// torn-down stream are dropped instead of poisoning the current one.
	sseEventMsg struct {
		gen int
		ev  api.OrgEvent
	}
	sseErrMsg struct {
		gen int
		err error
	}
	sseClosedMsg struct{ gen int }

	// sseFlushMsg delivers the trailing event of a debounced burst.
	sseFlushMsg struct{ key string }

	// sseStatusMsg tells screens whether the live event stream is up, so
	// they can stretch their poll interval while SSE covers them.
	sseStatusMsg struct{ connected bool }

	// rootOrgsMsg resolves the active org when the projects list gave none.
	rootOrgsMsg struct {
		items []Org
		err   error
	}
)

// sseState is the root model's half of the org event subscription.
type sseState struct {
	orgID       string
	gen         int
	cancel      context.CancelFunc
	events      <-chan api.OrgEvent
	errs        <-chan error
	connected   bool
	lastEventID string
	lastSent    map[string]time.Time
	pending     map[string]api.OrgEvent
	now         func() time.Time
}

func (s *sseState) ensure() {
	if s.lastSent == nil {
		s.lastSent = map[string]time.Time{}
	}
	if s.pending == nil {
		s.pending = map[string]api.OrgEvent{}
	}
	if s.now == nil {
		s.now = time.Now
	}
}

// waitEvent is the bubbletea subscription pump: it blocks on the channel and
// re-arms from the root's Update after each delivered message.
func waitEvent(gen int, ch <-chan api.OrgEvent) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return sseClosedMsg{gen}
		}
		return sseEventMsg{gen, ev}
	}
}

func waitErr(gen int, ch <-chan error) tea.Cmd {
	return func() tea.Msg {
		err, ok := <-ch
		if !ok {
			return sseClosedMsg{gen}
		}
		return sseErrMsg{gen, err}
	}
}

func fetchRootOrgs(cl *api.Client) tea.Cmd {
	return func() tea.Msg {
		items, err := getList[Org](cl, "/organizations/user")
		return rootOrgsMsg{items, err}
	}
}

// startSSE (re)subscribes to orgID's event stream, tearing down any previous
// subscription. lastEventID resumes replay across a same-org restart.
func (m *model) startSSE(orgID, lastEventID string) tea.Cmd {
	if m.cl == nil || orgID == "" {
		return nil
	}
	m.sse.ensure()
	if m.sse.cancel != nil {
		m.sse.cancel()
	}
	if orgID != m.sse.orgID {
		// drop the old org's debounce state: sseFlushMsg carries no generation,
		// so a queued trailing event would otherwise leak across the switch
		m.sse.lastSent = map[string]time.Time{}
		m.sse.pending = map[string]api.OrgEvent{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.sse.gen++
	m.sse.orgID = orgID
	m.sse.cancel = cancel
	m.sse.lastEventID = lastEventID
	events, errs := m.cl.SubscribeOrgEvents(ctx, orgID, lastEventID)
	m.sse.events, m.sse.errs = events, errs
	return tea.Batch(waitEvent(m.sse.gen, events), waitErr(m.sse.gen, errs), m.setSSEConnected(true))
}

// switchSSE re-subscribes only when the active org actually changes.
func (m *model) switchSSE(orgID string) tea.Cmd {
	if orgID == "" || orgID == m.sse.orgID {
		return nil
	}
	return m.startSSE(orgID, "")
}

func (m *model) setSSEConnected(v bool) tea.Cmd {
	if m.sse.connected == v {
		return nil
	}
	m.sse.connected = v
	return m.broadcast(sseStatusMsg{connected: v})
}

// notifySSEStatus delivers the current stream state to the top screen (used
// right after a push/replace so new screens start at the right tick cadence).
func (m model) notifySSEStatus() tea.Cmd {
	connected := m.sse.connected
	return func() tea.Msg { return sseStatusMsg{connected} }
}

// broadcast delivers msg to every screen in the stack, top first.
func (m *model) broadcast(msg tea.Msg) tea.Cmd {
	var cmds []tea.Cmd
	for i := len(m.stack) - 1; i >= 0; i-- {
		s, cmd := m.stack[i].Update(msg)
		m.stack[i] = s
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}
	return tea.Batch(cmds...)
}

// dispatchOrgEvent forwards ev to every screen implementing orgEventHandler,
// top first, batching whatever refresh commands they return.
func (m *model) dispatchOrgEvent(ev api.OrgEvent) tea.Cmd {
	var cmds []tea.Cmd
	for i := len(m.stack) - 1; i >= 0; i-- {
		if h, ok := m.stack[i].(orgEventHandler); ok {
			if cmd := h.OnOrgEvent(ev); cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
	}
	return tea.Batch(cmds...)
}

// deliverDebounced forwards ev now, or queues it as the trailing event of a
// burst keyed by (type, entity id).
func (m *model) deliverDebounced(ev api.OrgEvent) tea.Cmd {
	m.sse.ensure()
	key := ev.Type + "|" + ev.ID
	now := m.sse.now()
	if last, ok := m.sse.lastSent[key]; ok && now.Sub(last) < sseDebounce {
		_, queued := m.sse.pending[key]
		m.sse.pending[key] = ev
		if queued {
			return nil // flush already scheduled; just keep the latest event
		}
		wait := sseDebounce - now.Sub(last)
		return tea.Tick(wait, func(time.Time) tea.Msg { return sseFlushMsg{key} })
	}
	m.sse.lastSent[key] = now
	delete(m.sse.pending, key) // this event supersedes any still-queued trailing one
	return m.dispatchOrgEvent(ev)
}

// handleSSEMsg processes the root-level SSE machinery messages. handled=false
// means the message wasn't ours and should flow to the screens as usual.
func (m *model) handleSSEMsg(msg tea.Msg) (tea.Cmd, bool) {
	m.sse.ensure()
	switch msg := msg.(type) {
	case sseEventMsg:
		if msg.gen != m.sse.gen {
			return nil, true // stale pump from a torn-down subscription
		}
		cmds := []tea.Cmd{waitEvent(msg.gen, m.sse.events)}
		if msg.ev.EventID != "" {
			m.sse.lastEventID = msg.ev.EventID
		}
		if c := m.setSSEConnected(true); c != nil {
			cmds = append(cmds, c)
		}
		if c := m.deliverDebounced(msg.ev); c != nil {
			cmds = append(cmds, c)
		}
		if msg.ev.Type == "membership.changed" {
			// our project scoping just changed server-side: tear down and
			// resubscribe so the stream reflects the new membership
			if c := m.startSSE(m.sse.orgID, m.sse.lastEventID); c != nil {
				cmds = append(cmds, c)
			}
		}
		return tea.Batch(cmds...), true
	case sseErrMsg:
		if msg.gen != m.sse.gen {
			return nil, true
		}
		// reconnect notice from the subscription: screens fall back to fast
		// polling until the next delivered event proves the stream is live
		return tea.Batch(waitErr(msg.gen, m.sse.errs), m.setSSEConnected(false)), true
	case sseClosedMsg:
		if msg.gen == m.sse.gen {
			return m.setSSEConnected(false), true
		}
		return nil, true
	case sseFlushMsg:
		ev, ok := m.sse.pending[msg.key]
		if !ok {
			return nil, true
		}
		delete(m.sse.pending, msg.key)
		m.sse.lastSent[msg.key] = m.sse.now()
		return m.dispatchOrgEvent(ev), true
	case rootOrgsMsg:
		if m.sse.orgID == "" && msg.err == nil && len(msg.items) > 0 {
			return m.switchSSE(msg.items[0].ID), true
		}
		return nil, true
	}
	return nil, false
}

// screenOrg extracts the org a screen is scoped to, so the root can follow the
// user across orgs. Screens may implement orgID() to opt in explicitly.
func screenOrg(s screen) string {
	if o, ok := s.(interface{ orgID() string }); ok {
		return o.orgID()
	}
	switch v := s.(type) {
	case *projectScreen:
		return v.project.OrganizationID
	case *deploymentScreen:
		return v.project.OrganizationID
	}
	return ""
}

func orgFromProjects(items []Project) string {
	for _, p := range items {
		if p.OrganizationID != "" {
			return p.OrganizationID
		}
	}
	return ""
}
