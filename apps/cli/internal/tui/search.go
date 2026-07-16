package tui

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/LeafdTK/leaf/cli/internal/api"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/sahilm/fuzzy"
)

// quick search (ctrl+k / '/'): one fetch of the org overview + jobs, fuzzy
// filtering locally as you type. Results navigate straight to the entity.

const (
	searchCacheTTL = 45 * time.Second
	searchDebounce = 80 * time.Millisecond
	searchMaxRows  = 12
)

type searchItem struct {
	kind    string // project | deployment | database | job
	id      string
	name    string
	sub     string // context line: project name, host, schedule…
	status  string
	project Project
	hay     string // what fuzzy matches against
}

type searchIndex []searchItem

func (s searchIndex) String(i int) string { return s[i].hay }
func (s searchIndex) Len() int            { return len(s) }

// per-org index cache so reopening the palette doesn't refetch every time.
var searchCache = struct {
	mu    sync.Mutex
	byOrg map[string]searchCacheEntry
}{byOrg: map[string]searchCacheEntry{}}

type searchCacheEntry struct {
	items   []searchItem
	fetched time.Time
}

func searchCacheGet(orgID string) ([]searchItem, bool) {
	searchCache.mu.Lock()
	defer searchCache.mu.Unlock()
	e, ok := searchCache.byOrg[orgID]
	if !ok || time.Since(e.fetched) > searchCacheTTL {
		return nil, false
	}
	return e.items, true
}

func searchCachePut(orgID string, items []searchItem) {
	searchCache.mu.Lock()
	defer searchCache.mu.Unlock()
	searchCache.byOrg[orgID] = searchCacheEntry{items: items, fetched: time.Now()}
}

// overview response, trimmed to what the palette needs (see
// GET /overview/orgs/:slug — projects, deployments, and databases in one trip).
type overviewResp struct {
	Organization Org       `json:"organization"`
	Projects     []Project `json:"projects"`
	Deployments  []struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Status    string `json:"status"`
		Ingresses []struct {
			Host string `json:"host"`
		} `json:"ingresses"`
		Project Project `json:"project"`
	} `json:"deployments"`
	Databases []struct {
		ID      string  `json:"id"`
		Name    string  `json:"name"`
		Status  string  `json:"status"`
		Mode    string  `json:"mode"`
		Project Project `json:"project"`
	} `json:"databases"`
}

type orgJob struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	ScheduleCron string  `json:"scheduleCron"`
	Enabled      bool    `json:"enabled"`
	Project      Project `json:"project"`
}

type (
	searchIndexMsg struct {
		orgID string
		items []searchItem
		err   error
	}
	searchDebounceMsg struct{ gen int }
)

// loadSearchIndex resolves the org (falling back to the user's first org when
// the root hasn't learned one yet) and builds the palette index, cached per org.
func loadSearchIndex(cl *api.Client, orgID string) tea.Cmd {
	return func() tea.Msg {
		if items, ok := searchCacheGet(orgID); ok {
			return searchIndexMsg{orgID: orgID, items: items}
		}
		orgs, err := getList[Org](cl, "/organizations/user")
		if err != nil {
			return searchIndexMsg{err: err}
		}
		var org Org
		for _, o := range orgs {
			if o.ID == orgID {
				org = o
				break
			}
		}
		if org.ID == "" && len(orgs) > 0 {
			org = orgs[0]
		}
		if org.ID == "" || org.Slug == "" {
			return searchIndexMsg{err: errInvalid("no organization available to search")}
		}
		var ov overviewResp
		if err := cl.GetJSON(context.Background(), "/overview/orgs/"+url.PathEscape(org.Slug), &ov); err != nil {
			return searchIndexMsg{err: err}
		}
		// jobs are not part of the overview payload; best-effort second fetch
		jobs, _ := getList[orgJob](cl, "/organizations/"+url.PathEscape(org.ID)+"/jobs")
		items := buildSearchItems(ov, jobs)
		searchCachePut(org.ID, items)
		return searchIndexMsg{orgID: org.ID, items: items}
	}
}

func buildSearchItems(ov overviewResp, jobs []orgJob) []searchItem {
	items := make([]searchItem, 0, len(ov.Projects)+len(ov.Deployments)+len(ov.Databases)+len(jobs))
	add := func(it searchItem) {
		it.hay = it.name + " " + it.sub + " " + it.kind
		items = append(items, it)
	}
	for _, p := range ov.Projects {
		add(searchItem{kind: "project", id: p.ID, name: p.Name, sub: p.Slug, project: p})
	}
	for _, d := range ov.Deployments {
		sub := d.Project.Name
		if len(d.Ingresses) > 0 && d.Ingresses[0].Host != "" {
			sub += " · " + d.Ingresses[0].Host
		}
		add(searchItem{kind: "deployment", id: d.ID, name: d.Name, sub: sub, status: d.Status, project: d.Project})
	}
	for _, db := range ov.Databases {
		add(searchItem{kind: "database", id: db.ID, name: db.Name, sub: db.Project.Name, status: db.Status, project: db.Project})
	}
	for _, j := range jobs {
		sub := j.Project.Name
		if j.ScheduleCron != "" {
			sub += " · " + j.ScheduleCron
		}
		add(searchItem{kind: "job", id: j.ID, name: j.Name, sub: sub, project: j.Project})
	}
	return items
}

type searchScreen struct {
	cl      *api.Client
	orgID   string
	input   textinput.Model
	items   []searchItem
	results []searchItem
	cursor  int
	gen     int // debounce generation for re-ranking
	loading bool
	err     error
	w, h    int
}

func newSearchScreen(cl *api.Client, orgID string) *searchScreen {
	ti := textinput.New()
	ti.Placeholder = "search projects, deployments, databases, jobs…"
	ti.Prompt = stAccent.Render("⌕ ")
	ti.CharLimit = 128
	ti.Focus()
	return &searchScreen{cl: cl, orgID: orgID, input: ti, loading: true}
}

func (s *searchScreen) title() string { return "Search" }

func (s *searchScreen) grabsKeys() bool { return true }

func (s *searchScreen) help() []keyHint {
	return []keyHint{{"↑/↓", "move"}, {"enter", "open"}, {"esc", "close"}}
}

func (s *searchScreen) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, loadSearchIndex(s.cl, s.orgID))
}

func (s *searchScreen) rank() {
	q := strings.TrimSpace(s.input.Value())
	if q == "" {
		s.results = s.items
	} else {
		matches := fuzzy.FindFrom(q, searchIndex(s.items))
		s.results = make([]searchItem, len(matches))
		for i, m := range matches {
			s.results[i] = s.items[m.Index]
		}
	}
	if s.cursor >= len(s.results) {
		s.cursor = 0
	}
}

// open navigates to the selected entity, replacing the palette so esc from
// the target returns to where the palette was opened.
func (s *searchScreen) open(it searchItem) tea.Cmd {
	switch it.kind {
	case "project":
		return replace(newProjectScreen(s.cl, it.project))
	case "deployment":
		return replace(newDeploymentScreen(s.cl, it.project, it.id, it.name))
	case "database":
		return replace(newDatabaseScreen(s.cl, it.project, it.id, it.name))
	case "job":
		return replace(newJobDetailScreen(s.cl, s.orgID, Job{ID: it.id, Name: it.name}))
	}
	return nil
}

func (s *searchScreen) Update(msg tea.Msg) (screen, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		s.w, s.h = msg.Width, msg.Height
		s.input.Width = s.boxW() - 8
	case searchIndexMsg:
		s.loading = false
		s.err = msg.err
		if msg.err == nil {
			if msg.orgID != "" {
				s.orgID = msg.orgID
			}
			s.items = msg.items
			s.rank()
		}
	case searchDebounceMsg:
		if msg.gen == s.gen {
			s.rank()
		}
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			return s, pop
		case "up", "ctrl+p":
			if s.cursor > 0 {
				s.cursor--
			}
			return s, nil
		case "down", "ctrl+n":
			if s.cursor < len(s.results)-1 {
				s.cursor++
			}
			return s, nil
		case "enter":
			if s.cursor < len(s.results) {
				return s, s.open(s.results[s.cursor])
			}
			return s, nil
		}
		before := s.input.Value()
		var cmd tea.Cmd
		s.input, cmd = s.input.Update(msg)
		if s.input.Value() != before {
			s.gen++
			gen := s.gen
			return s, tea.Batch(cmd, tea.Tick(searchDebounce, func(time.Time) tea.Msg {
				return searchDebounceMsg{gen}
			}))
		}
		return s, cmd
	case tea.MouseMsg:
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if s.cursor > 0 {
				s.cursor--
			}
		case tea.MouseButtonWheelDown:
			if s.cursor < len(s.results)-1 {
				s.cursor++
			}
		}
	}
	var cmd tea.Cmd
	s.input, cmd = s.input.Update(msg)
	return s, cmd
}

func (s *searchScreen) boxW() int {
	return min(max(s.w-12, 44), 84)
}

func kindStyle(k string) lipgloss.Style {
	switch k {
	case "project":
		return stAccent
	case "deployment":
		return stGreen
	case "database":
		return stYellow
	default:
		return stKey
	}
}

func (s *searchScreen) View() string {
	boxW := s.boxW()
	var b strings.Builder
	b.WriteString(s.input.View() + "\n")
	b.WriteString(stMuted.Render(strings.Repeat("─", max(boxW-6, 1))) + "\n")

	switch {
	case s.loading:
		b.WriteString(stMuted.Render("indexing org…"))
	case s.err != nil:
		b.WriteString(stRed.Render("✗ " + s.err.Error()))
	case len(s.results) == 0:
		b.WriteString(stMuted.Render("no matches"))
	default:
		start := clampStart(s.cursor, len(s.results), searchMaxRows)
		end := min(start+searchMaxRows, len(s.results))
		for i := start; i < end; i++ {
			it := s.results[i]
			badge := kindStyle(it.kind).Render(pad(it.kind, 10))
			line := badge + " " + pad(it.name, 24) + " " + stMuted.Render(it.sub)
			if it.status != "" {
				line += "  " + statusDot(it.status)
			}
			if i == s.cursor {
				b.WriteString(stSelBar.Render("▌") + stSelected.Render(fitLine(" "+it.kind+"  "+it.name+"  "+it.sub, boxW-6)))
			} else {
				b.WriteString("  " + line)
			}
			if i < end-1 {
				b.WriteString("\n")
			}
		}
	}

	rows := strings.Count(b.String(), "\n") + 3
	box := panel("Quick search", b.String(), boxW, max(rows, 6), true)
	return lipgloss.Place(s.w, max(s.h-chromeH, 1), lipgloss.Center, lipgloss.Center, box)
}
