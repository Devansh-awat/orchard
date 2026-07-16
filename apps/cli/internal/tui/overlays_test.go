package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

type ovCapture struct {
	mu     sync.Mutex
	bodies map[string]string
	counts map[string]int
}

func (c *ovCapture) body(key string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bodies[key]
}

func (c *ovCapture) count(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.counts[key]
}

func ovFakeAPI(t *testing.T) (*api.Client, *ovCapture) {
	t.Helper()
	cap := &ovCapture{bodies: map[string]string{}, counts: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body []byte
		if r.Body != nil {
			body, _ = io.ReadAll(r.Body)
		}
		key := r.Method + " " + r.URL.Path
		cap.mu.Lock()
		cap.bodies[key] = string(body)
		cap.counts[key]++
		cap.mu.Unlock()
		switch key {
		case "GET /apiv1/organizations/user":
			w.Write([]byte(`[{"id":"o1","name":"Acme","slug":"acme"},{"id":"o2","name":"Beta","slug":"beta"}]`))
		case "GET /apiv1/organizations/o1":
			w.Write([]byte(`{"id":"o1","name":"Acme","slug":"acme","plan":"pro","subdomain":"acme-apps","createdAt":"2026-01-01T00:00:00.000Z"}`))
		case "GET /apiv1/organizations/o1/members":
			w.Write([]byte(`[{"id":"m1","role":"owner","addedAt":"2026-01-02T00:00:00.000Z","user":{"email":"leaf@acme.dev","username":"leaf"}},` +
				`{"id":"m2","role":"member","addedAt":"2026-02-03T00:00:00.000Z","user":{"email":"bob@acme.dev","firstName":"Bob","lastName":"Ross"}}]`))
		case "GET /apiv1/organizations/o1/notification-channels":
			w.Write([]byte(`[{"id":"c1","type":"discord","name":"deploy-alerts","enabled":true,"events":["deploy.failed","pod.crashing"],"projectIds":[]}]`))
		case "POST /apiv1/organizations/o1/notification-channels/c1/test":
			w.Write([]byte(`{"success":true}`))
		case "GET /apiv1/organizations/o1/backup-settings":
			w.Write([]byte(`{"endpoint":"https://r2.example.com","bucket":"acme-backups","region":"auto","accessKeyConfigured":true,"accessKeyLast4":"ab12","secretKeyConfigured":true}`))
		case "GET /apiv1/audit-logs/organization/o1":
			w.Write([]byte(`{"entries":[{"id":"a1","createdAt":"2026-07-01T10:00:00.000Z","action":"deployment.create","actorEmail":"leaf@acme.dev","targetType":"deployment","targetLabel":"api","metadata":{"image":"nginx:latest"}}]}`))
		case "GET /apiv1/overview/orgs/acme":
			w.Write([]byte(`{"organization":{"id":"o1","name":"Acme","slug":"acme"},` +
				`"projects":[{"id":"p1","name":"web-app","slug":"web","organizationId":"o1"}],` +
				`"deployments":[{"id":"d1","name":"api","status":"running","ingresses":[{"host":"api.acme.dev"}],"project":{"id":"p1","name":"web-app","slug":"web","organizationId":"o1"}}],` +
				`"databases":[{"id":"db1","name":"maindb","status":"ready","mode":"cnpg","project":{"id":"p1","name":"web-app","slug":"web","organizationId":"o1"}}]}`))
		case "GET /apiv1/organizations/o1/jobs":
			w.Write([]byte(`[{"id":"j1","name":"nightly-backup","scheduleCron":"0 3 * * *","enabled":true,"project":{"id":"p1","name":"web-app","slug":"web"}}]`))
		case "GET /apiv1/projects/p1/environments":
			w.Write([]byte(`[{"id":"e1","name":"production","slug":"prod","isDefault":true},{"id":"e2","name":"staging","slug":"stg","isDefault":false}]`))
		default:
			w.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(srv.Close)
	return api.New(srv.URL, "tok"), cap
}

func ovResetSearchCache() {
	searchCache.mu.Lock()
	searchCache.byOrg = map[string]searchCacheEntry{}
	searchCache.mu.Unlock()
}

func ovRunes(k string) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
}

// ---- global key routing ----

func TestGlobalKeysOpenOverlays(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	m := model{cl: cl, stack: []screen{newProjectsScreen(cl)}}

	_, cmd := m.Update(ovRunes("o"))
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("'o' should push the org switcher")
	} else if _, ok := ps.s.(*switcherScreen); !ok {
		t.Fatalf("'o' pushed %T, want *switcherScreen", ps.s)
	}

	_, cmd = m.Update(ovRunes("/"))
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("'/' should push quick search")
	} else if _, ok := ps.s.(*searchScreen); !ok {
		t.Fatalf("'/' pushed %T, want *searchScreen", ps.s)
	}

	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("ctrl+k should push quick search")
	} else if _, ok := ps.s.(*searchScreen); !ok {
		t.Fatalf("ctrl+k pushed %T, want *searchScreen", ps.s)
	}
}

func TestGlobalKeysSuppressedWhileTyping(t *testing.T) {
	cl, _ := ovFakeAPI(t)

	// env editor captures raw text: '/' must reach the textarea, not the palette
	m := model{cl: cl, stack: []screen{newEnvScreen(cl, "d1", nil)}}
	_, cmd := m.Update(ovRunes("/"))
	if _, ok := run(cmd).(pushScreen); ok {
		t.Fatal("'/' must not open search while the env editor is focused")
	}

	// an armed confirm modal swallows 'o' instead of opening the switcher
	d := &deploymentScreen{cl: cl, id: "d1", name: "api"}
	d.confirm.Show("Delete?", nil)
	m = model{cl: cl, stack: []screen{d}}
	_, cmd = m.Update(ovRunes("o"))
	if _, ok := run(cmd).(pushScreen); ok {
		t.Fatal("'o' must not open the switcher while a modal is up")
	}
	if !d.confirm.Active() {
		t.Fatal("'o' should be swallowed by the modal, not dismiss it")
	}

	// forms capture text too
	m = model{cl: cl, stack: []screen{inviteMemberForm(cl, "o1")}}
	_, cmd = m.Update(ovRunes("o"))
	if _, ok := run(cmd).(pushScreen); ok {
		t.Fatal("'o' must not open the switcher while a form field is focused")
	}
}

func TestGlobalKeybarHints(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	m := model{cl: cl, w: 120, stack: []screen{newProjectsScreen(cl)}}
	bar := m.bottomBar()
	if !strings.Contains(bar, "ctrl+k") || !strings.Contains(bar, "org") {
		t.Fatalf("keybar should advertise the global overlays:\n%s", bar)
	}

	// hidden while the top screen captures raw keys
	m.stack = []screen{newEnvScreen(cl, "d1", nil)}
	if bar := m.bottomBar(); strings.Contains(bar, "ctrl+k") {
		t.Fatalf("keybar must not advertise search while typing:\n%s", bar)
	}
}

// ---- org switcher ----

func TestSwitcherRendersAndSwitchesOrg(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	var s screen = newSwitcherScreen(cl, "o1", nil)
	s, _ = s.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	s, _ = s.Update(run(s.Init()))

	v := s.View()
	if !strings.Contains(v, "Acme") || !strings.Contains(v, "Beta") {
		t.Fatalf("switcher missing orgs:\n%s", v)
	}
	if !strings.Contains(v, "current") {
		t.Fatalf("switcher should mark the active org:\n%s", v)
	}

	s, _ = s.Update(ovRunes("j"))
	_, cmd := s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	sel, ok := run(cmd).(orgSelectedMsg)
	if !ok || sel.org.ID != "o2" {
		t.Fatalf("enter should select Beta, got %+v", sel)
	}

	// the root collapses to a fresh projects list on org switch
	m := model{cl: cl, w: 100, h: 30, stack: []screen{newProjectsScreen(cl), s}}
	m.sse.orgID = "o2" // already subscribed: no real resubscribe in the test
	nm, cmd := m.Update(sel)
	root := nm.(model)
	if len(root.stack) != 1 {
		t.Fatalf("org switch should collapse the stack, got %d screens", len(root.stack))
	}
	if _, ok := root.top().(*projectsScreen); !ok {
		t.Fatalf("org switch should land on projects, got %T", root.top())
	}
	if cmd == nil {
		t.Fatal("org switch should reload projects")
	}
}

func TestSwitcherEnvMode(t *testing.T) {
	cl, cap := ovFakeAPI(t)
	p := &Project{ID: "p1", Name: "web-app", OrganizationID: "o1"}
	var s screen = newSwitcherScreen(cl, "o1", p)
	s, _ = s.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	s, _ = s.Update(run(fetchOrgs(cl)))
	s, _ = s.Update(run(fetchProjectEnvs(cl, "p1")))

	s, _ = s.Update(tea.KeyMsg{Type: tea.KeyTab})
	v := s.View()
	if !strings.Contains(v, "production") || !strings.Contains(v, "staging") {
		t.Fatalf("env mode missing environments:\n%s", v)
	}
	if !strings.Contains(v, "default") {
		t.Fatalf("env mode should mark the default env:\n%s", v)
	}

	// enter on the already-default env is a no-op flash
	_, cmd := s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if _, ok := run(cmd).(flash); !ok {
		t.Fatal("enter on the default env should just flash")
	}

	// enter on staging promotes it
	s, _ = s.Update(ovRunes("j"))
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if msg, ok := run(cmd).(actionMsg); !ok || msg.err != nil {
		t.Fatalf("set-default failed: %+v", msg)
	}
	if cap.count("POST /apiv1/environments/e2/set-default") != 1 {
		t.Fatal("set-default endpoint not hit for staging")
	}
}

func TestSwitcherOpensOrgSettings(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	var s screen = newSwitcherScreen(cl, "o1", nil)
	s, _ = s.Update(run(fetchOrgs(cl)))
	_, cmd := s.Update(ovRunes("s"))
	ps, ok := run(cmd).(pushScreen)
	if !ok {
		t.Fatal("'s' should push org settings")
	}
	os, ok := ps.s.(*orgSettingsScreen)
	if !ok || os.id != "o1" {
		t.Fatalf("expected settings for o1, got %T %+v", ps.s, ps.s)
	}
}

// ---- quick search ----

func loadedSearch(t *testing.T, cl *api.Client) *searchScreen {
	t.Helper()
	ovResetSearchCache()
	s := newSearchScreen(cl, "o1")
	var sc screen = s
	sc, _ = sc.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	msg := run(loadSearchIndex(cl, "o1"))
	idx, ok := msg.(searchIndexMsg)
	if !ok || idx.err != nil {
		t.Fatalf("index load failed: %+v", msg)
	}
	sc, _ = sc.Update(idx)
	return s
}

func searchType(t *testing.T, s *searchScreen, q string) {
	t.Helper()
	var sc screen = s
	for _, r := range q {
		sc, _ = sc.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	sc, _ = sc.Update(searchDebounceMsg{gen: s.gen})
}

func TestSearchIndexAndRender(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	s := loadedSearch(t, cl)
	v := s.View()
	for _, want := range []string{"web-app", "api", "maindb", "nightly-backup"} {
		if !strings.Contains(v, want) {
			t.Fatalf("search view missing %q:\n%s", want, v)
		}
	}
}

func TestSearchFuzzyFiltersAndNavigates(t *testing.T) {
	cl, _ := ovFakeAPI(t)

	s := loadedSearch(t, cl)
	searchType(t, s, "maindb")
	if len(s.results) == 0 || s.results[0].kind != "database" {
		t.Fatalf("query 'maindb' should rank the database first, got %+v", s.results)
	}
	_, cmd := s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if rs, ok := run(cmd).(replaceScreen); !ok {
		t.Fatal("enter should replace the palette with the target screen")
	} else if _, ok := rs.s.(*databaseScreen); !ok {
		t.Fatalf("database result opened %T, want *databaseScreen", rs.s)
	}

	s = loadedSearch(t, cl)
	searchType(t, s, "nightly")
	if len(s.results) == 0 || s.results[0].kind != "job" {
		t.Fatalf("query 'nightly' should rank the job first, got %+v", s.results)
	}
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if rs, ok := run(cmd).(replaceScreen); !ok {
		t.Fatal("enter should navigate to the job")
	} else if _, ok := rs.s.(*jobDetailScreen); !ok {
		t.Fatalf("job result opened %T, want *jobDetailScreen", rs.s)
	}

	s = loadedSearch(t, cl)
	searchType(t, s, "api")
	if len(s.results) == 0 || s.results[0].kind != "deployment" {
		t.Fatalf("query 'api' should rank the deployment first, got %+v", s.results)
	}
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if rs, ok := run(cmd).(replaceScreen); !ok {
		t.Fatal("enter should navigate to the deployment")
	} else if ds, ok := rs.s.(*deploymentScreen); !ok || ds.id != "d1" {
		t.Fatalf("deployment result opened %T, want *deploymentScreen d1", rs.s)
	}

	s = loadedSearch(t, cl)
	searchType(t, s, "web-app")
	if len(s.results) == 0 || s.results[0].kind != "project" {
		t.Fatalf("query 'web-app' should rank the project first, got %+v", s.results)
	}
	_, cmd = s.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if rs, ok := run(cmd).(replaceScreen); !ok {
		t.Fatal("enter should navigate to the project")
	} else if _, ok := rs.s.(*projectScreen); !ok {
		t.Fatalf("project result opened %T, want *projectScreen", rs.s)
	}
}

func TestSearchCachePerOrg(t *testing.T) {
	cl, cap := ovFakeAPI(t)
	ovResetSearchCache()
	if msg := run(loadSearchIndex(cl, "o1")).(searchIndexMsg); msg.err != nil {
		t.Fatalf("first load failed: %v", msg.err)
	}
	if msg := run(loadSearchIndex(cl, "o1")).(searchIndexMsg); msg.err != nil {
		t.Fatalf("cached load failed: %v", msg.err)
	}
	if n := cap.count("GET /apiv1/overview/orgs/acme"); n != 1 {
		t.Fatalf("overview should be fetched once and then cached, got %d fetches", n)
	}
}

// ---- org settings ----

func loadedOrgSettings(t *testing.T, cl *api.Client) *orgSettingsScreen {
	t.Helper()
	s := newOrgSettingsScreen(cl, "o1")
	var sc screen = s
	sc, _ = sc.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	for _, cmd := range []tea.Cmd{
		fetchOrgDetail(cl, "o1"), fetchOrgMembers(cl, "o1"), fetchOrgChannels(cl, "o1"),
		fetchOrgBackup(cl, "o1"), fetchOrgAudit(cl, "o1"),
	} {
		sc, _ = sc.Update(run(cmd))
	}
	return s
}

func TestOrgSettingsTabsRender(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	s := loadedOrgSettings(t, cl)
	var sc screen = s

	if v := sc.View(); !strings.Contains(v, "Acme") || !strings.Contains(v, "acme-apps") {
		t.Fatalf("general tab missing org info:\n%s", v)
	}

	sc, _ = sc.Update(ovRunes("2"))
	v := sc.View()
	if !strings.Contains(v, "leaf") || !strings.Contains(v, "owner") || !strings.Contains(v, "Bob Ross") {
		t.Fatalf("members tab missing rows:\n%s", v)
	}

	sc, _ = sc.Update(ovRunes("3"))
	if v := sc.View(); !strings.Contains(v, "deploy-alerts") || !strings.Contains(v, "enabled") {
		t.Fatalf("notifications tab missing channel:\n%s", v)
	}

	sc, _ = sc.Update(ovRunes("4"))
	v = sc.View()
	if !strings.Contains(v, "acme-backups") || !strings.Contains(v, "ends in ab12") {
		t.Fatalf("backups tab missing settings:\n%s", v)
	}

	sc, _ = sc.Update(ovRunes("5"))
	if v := sc.View(); !strings.Contains(v, "deployment.create") {
		t.Fatalf("audit tab missing entry:\n%s", v)
	}
	// enter expands the entry with its metadata
	sc, _ = sc.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if v := sc.View(); !strings.Contains(v, "Metadata") || !strings.Contains(v, "nginx:latest") {
		t.Fatalf("expanded audit entry missing metadata:\n%s", v)
	}
}

func TestOrgSettingsTabClick(t *testing.T) {
	cl, _ := ovFakeAPI(t)
	s := loadedOrgSettings(t, cl)
	var sc screen = s
	_ = sc.View() // records tabSpans
	sc, _ = sc.Update(tea.MouseMsg{X: s.tabSpans[2][0], Y: 1, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	if s.tab != 2 {
		t.Fatalf("clicking the Notifications tab should activate it, got tab=%d", s.tab)
	}
}

func TestOrgSettingsMemberActions(t *testing.T) {
	cl, cap := ovFakeAPI(t)
	s := loadedOrgSettings(t, cl)
	var sc screen = s
	sc, _ = sc.Update(ovRunes("2"))

	// invite opens a form
	_, cmd := sc.Update(ovRunes("i"))
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("'i' should push the invite form")
	} else if _, ok := ps.s.(*formScreen); !ok {
		t.Fatalf("invite pushed %T, want *formScreen", ps.s)
	}

	// invite form validates the role and posts to the members endpoint
	form := inviteMemberForm(cl, "o1")
	form.fields[0].ti.SetValue("new@acme.dev")
	form.fields[1].ti.SetValue("guest")
	_, cmd = form.doSubmit()
	if res := run(cmd).(formResult); res.err == nil {
		t.Fatal("guest invites must be rejected client-side")
	}
	form = inviteMemberForm(cl, "o1")
	form.fields[0].ti.SetValue("new@acme.dev")
	form.fields[1].ti.SetValue("admin")
	_, cmd = form.doSubmit()
	if res := run(cmd).(formResult); res.err != nil {
		t.Fatalf("invite failed: %v", res.err)
	}
	body := cap.body("POST /apiv1/organizations/o1/members")
	if !strings.Contains(body, `"email":"new@acme.dev"`) || !strings.Contains(body, `"role":"admin"`) {
		t.Fatalf("invite body wrong: %q", body)
	}

	// set-role PATCHes the member
	form = setRoleForm(cl, "o1", s.members[1])
	form.fields[0].ti.SetValue("admin")
	_, cmd = form.doSubmit()
	if res := run(cmd).(formResult); res.err != nil {
		t.Fatalf("set-role failed: %v", res.err)
	}
	if body := cap.body("PATCH /apiv1/organizations/o1/members/m2"); !strings.Contains(body, `"role":"admin"`) {
		t.Fatalf("set-role body wrong: %q", body)
	}

	// remove arms the confirm modal, y fires the DELETE
	sc, _ = sc.Update(ovRunes("x"))
	if !s.confirm.Active() {
		t.Fatal("'x' should arm the remove confirmation")
	}
	_, cmd = sc.Update(ovRunes("y"))
	if msg, ok := run(cmd).(actionMsg); !ok || msg.err != nil {
		t.Fatalf("remove failed: %+v", msg)
	}
	if cap.count("DELETE /apiv1/organizations/o1/members/m1") != 1 {
		t.Fatal("remove endpoint not hit")
	}
}

func TestOrgSettingsChannelActions(t *testing.T) {
	cl, cap := ovFakeAPI(t)
	s := loadedOrgSettings(t, cl)
	var sc screen = s
	sc, _ = sc.Update(ovRunes("3"))

	// 'e' toggles the enabled flag off (channel starts enabled)
	_, cmd := sc.Update(ovRunes("e"))
	if msg, ok := run(cmd).(actionMsg); !ok || msg.err != nil {
		t.Fatalf("toggle failed: %+v", msg)
	}
	if body := cap.body("PATCH /apiv1/organizations/o1/notification-channels/c1"); !strings.Contains(body, `"enabled":false`) {
		t.Fatalf("toggle body wrong: %q", body)
	}

	// 't' sends a test notification
	_, cmd = sc.Update(ovRunes("t"))
	if msg, ok := run(cmd).(actionMsg); !ok || msg.err != nil {
		t.Fatalf("test send failed: %+v", msg)
	}
	if cap.count("POST /apiv1/organizations/o1/notification-channels/c1/test") != 1 {
		t.Fatal("test endpoint not hit")
	}
}

func TestOrgSettingsRenameForm(t *testing.T) {
	cl, cap := ovFakeAPI(t)
	s := loadedOrgSettings(t, cl)
	var sc screen = s

	_, cmd := sc.Update(ovRunes("e"))
	if ps, ok := run(cmd).(pushScreen); !ok {
		t.Fatal("'e' on General should push the rename form")
	} else if _, ok := ps.s.(*formScreen); !ok {
		t.Fatalf("rename pushed %T, want *formScreen", ps.s)
	}

	form := renameOrgForm(cl, s.org)
	form.fields[0].ti.SetValue("Acme Rockets")
	_, cmd = form.doSubmit()
	if res := run(cmd).(formResult); res.err != nil {
		t.Fatalf("rename failed: %v", res.err)
	}
	if body := cap.body("PATCH /apiv1/organizations/o1"); !strings.Contains(body, `"name":"Acme Rockets"`) {
		t.Fatalf("rename body wrong: %q", body)
	}

	// a JSON round-trip sanity check on the audit metadata pretty-printer
	e := auditEntry{Metadata: json.RawMessage(`{"image":"nginx"}`)}
	s.audit = []auditEntry{e}
	s.auCursor = 0
	if d := s.auditDetail(); !strings.Contains(d, "nginx") {
		t.Fatalf("audit detail missing metadata: %s", d)
	}
}
